//! Local GPU memory admission. Tests supply readings; unavailable telemetry
//! preserves the existing concurrency behavior.
use super::planner::Device;
use std::sync::{Arc,Mutex};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration,Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reading { pub free_mib: u64, pub total_mib: u64 }
impl Reading {
    pub fn limit(&self, per_encode_mib: u64) -> u64 { self.free_mib.saturating_sub(128) / per_encode_mib.max(1) }
}
/// Context/encoder overhead plus 64 NV12-sized surfaces (decode, lookahead,
/// encoder and transfer buffers). Unknown dimensions budget for UHD. This is
/// a conservative estimate, not a claim to measure a driver's allocation.
pub fn estimate_mib(dimensions: Option<(u64,u64)>) -> u64 {
    let (w,h)=dimensions.filter(|(w,h)|*w>0&&*h>0).unwrap_or((3840,2160));
    512 + w.saturating_mul(h).saturating_mul(96).div_ceil(1024*1024)
}
pub fn exhausted(stderr: &str) -> bool {
    let s=stderr.to_ascii_lowercase();
    let gpu=["nvenc","cuda","vaapi","va-api","qsv","mfx","avhw"].iter().any(|tag|s.contains(tag));
    gpu && ["out of memory","out_of_memory","cannot allocate memory","memory_alloc","memory allocation failed","resource allocation failed"].iter().any(|p|s.contains(p))
}
pub fn read_nvidia(runner: &dyn super::process::Runner, device: &Device) -> Option<Reading> {
    if device.kind!="nvidia" {return None;}
    let pci=super::devices::normalize_pci_slot(device.id.strip_prefix("pci:")?)?;
    let args=vec![format!("--id={pci}"),"--query-gpu=pci.bus_id,memory.free,memory.total".into(),"--format=csv,noheader,nounits".into()];
    let r=runner.run("nvidia-smi",&args,&super::process::RunOptions{timeout_ms:Some(2000),..Default::default()}).ok()?;
    if r.status!=Some(0)||r.timed_out||r.aborted||r.output_limit_exceeded||r.error.is_some() {return None;}
    let rows:Vec<_>=r.stdout.lines().filter(|l|!l.trim().is_empty()).collect();
    if rows.len()!=1 {return None;}
    let p:Vec<_>=rows[0].split(',').map(str::trim).collect();
    if p.len()!=3 || super::devices::normalize_pci_slot(p[0]).as_deref()!=Some(&pci) {return None;}
    let (free,total)=(p[1].parse::<u64>().ok()?,p[2].parse::<u64>().ok()?);
    (total>0&&free<=total).then_some(Reading{free_mib:free,total_mib:total})
}
pub type Sampler = Arc<dyn Fn(&Device) -> Option<Reading> + Send + Sync>;
#[derive(Default)]
struct Usage { mib:u64, active:usize, serial:usize, pressure_until:Option<Instant>, next_waiter:u64, waiters:VecDeque<u64> }
pub struct Gate { sample: Sampler, usage:Mutex<HashMap<String,Usage>> }
pub struct Lease { gate:Arc<Gate>, id:String, mib:u64, serial:bool }
/// A queued retry closes normal admission before waiting for existing encodes.
/// Dropping it on pause, cancellation or timeout always reopens admission.
pub struct SerialWait { gate:Arc<Gate>, device:Device, ticket:u64 }
impl SerialWait {
    pub fn try_reserve(&self, mib:u64)->Option<Lease> { self.gate.reserve(&self.device,mib,true,Some(self.ticket)) }
    pub fn waiting_on_encodes(&self)->bool {
        self.gate.usage.lock().unwrap().get(&self.device.id)
            .is_some_and(|u|u.active>0 || u.waiters.front()!=Some(&self.ticket))
    }
}
impl Drop for SerialWait {
    fn drop(&mut self) {
        if let Some(u)=self.gate.usage.lock().unwrap().get_mut(&self.device.id) { u.waiters.retain(|t|*t!=self.ticket); }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut usage=self.gate.usage.lock().unwrap();
        if let Some(u)=usage.get_mut(&self.id) {
            u.mib=u.mib.saturating_sub(self.mib);u.active=u.active.saturating_sub(1);
            if self.serial {u.serial=u.serial.saturating_sub(1);}
        }
    }
}
impl Gate {
    pub fn new(sample: Sampler) -> Self { Self { sample,usage:Mutex::new(HashMap::new()) } }
    pub fn system() -> Self {
        let runner=super::process::BoundedRunner{timeout_ms:2000,max_output_bytes:4096,grace_ms:250};
        Self::new(Arc::new(move |device|read_nvidia(&runner,device)))
    }
    pub fn reading(&self, device: &Device) -> Option<Reading> { (self.sample)(device) }
    pub fn pressure(&self, device: &Device) {
        self.usage.lock().unwrap().entry(device.id.clone()).or_default().pressure_until=Some(Instant::now()+Duration::from_secs(60));
    }
    pub fn pressured(&self, device:&Device)->bool {
        self.usage.lock().unwrap().get(&device.id).and_then(|u|u.pressure_until).is_some_and(|t|t>Instant::now())
    }
    pub fn wait_serial(self:&Arc<Self>, device:&Device)->SerialWait {
        let mut usage=self.usage.lock().unwrap();
        let u=usage.entry(device.id.clone()).or_default();
        let ticket=u.next_waiter; u.next_waiter+=1; u.waiters.push_back(ticket);
        SerialWait{gate:self.clone(),device:device.clone(),ticket}
    }
    pub fn draining(&self, device:&Device)->bool {
        self.usage.lock().unwrap().get(&device.id).is_some_and(|u|
            !u.waiters.is_empty() || u.serial>0 || (u.active>0 && u.pressure_until.is_some_and(|t|t>Instant::now())))
    }
    pub fn try_reserve(self: &Arc<Self>, device: &Device, mib: u64, serial: bool) -> Option<Lease> {
        self.reserve(device,mib,serial,None)
    }
    fn reserve(self: &Arc<Self>, device: &Device, mib: u64, serial: bool, ticket:Option<u64>) -> Option<Lease> {
        // Query and reserve under one lock: simultaneous starts cannot all use
        // the same reading. Count our estimates as well as reported usage;
        // this intentionally leaves headroom while allocations are still rising.
        let mut usage=self.usage.lock().unwrap();
        let u=usage.entry(device.id.clone()).or_default();
        if !u.waiters.is_empty() && ticket!=u.waiters.front().copied() {return None;}
        if u.active>0 && (serial || u.serial>0 || u.pressure_until.is_some_and(|t|t>Instant::now())) {return None;}
        if self.reading(device).is_some_and(|r|r.free_mib.saturating_sub(128)<u.mib.saturating_add(mib)) {return None;}
        u.active+=1;u.mib=u.mib.saturating_add(mib);if serial {u.serial+=1;}
        Some(Lease{gate:self.clone(),id:device.id.clone(),mib,serial})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converter::devices::device_of;
    use serde_json::json;
    #[test]
    fn gpu_memory_query_uses_pci_identity_and_validates_the_reading() {
        struct Query;
        impl crate::converter::process::Runner for Query {
            fn run(&self, c:&str,a:&[String],o:&crate::converter::process::RunOptions)->Result<crate::converter::process::ProcResult,String>{
                assert_eq!(c,"nvidia-smi"); assert!(a.contains(&"--id=0000:01:00.0".into()));
                assert!(o.timeout_ms.unwrap()<=3000);
                Ok(crate::converter::process::ProcResult {status:Some(0),stdout:"00000000:01:00.0, 1304, 8192\n".into(),..Default::default()})
            }
        }
        let gpu=device_of(&json!({"id":"pci:0000:01:00.0","kind":"nvidia","index":7}));
        assert_eq!(read_nvidia(&Query,&gpu),Some(Reading{free_mib:1304,total_mib:8192}));
        assert_eq!(read_nvidia(&Query,&device_of(&json!({"id":"cpu","kind":"cpu"}))),None);
    }
    #[test]
    fn gpu_memory_error_patterns_require_memory_evidence() {
        for log in ["[hevc_nvenc] InitializeEncoder failed: out of memory (10)",
            "[hevc_nvenc] EncodePicture failed!: out of memory (10)",
            "[CUDA] cu->cuMemAlloc(...) failed -> CUDA_ERROR_OUT_OF_MEMORY\nError submitting packet to decoder",
            "[hevc_vaapi] Failed to allocate surfaces: resource allocation failed",
            "[hevc_qsv] Error initializing an MFX session: MFX_ERR_MEMORY_ALLOC",
            "[hevc_qsv] Error initializing an MFX session: memory allocation failed (-4)",
            "[AVHWDeviceContext] Cannot allocate memory"] {
            assert!(exhausted(log), "{log}");
        }
        for log in ["Error submitting packet to decoder", "invalid NAL unit", "No such file", "frame-count-mismatch"] {
            assert!(!exhausted(log), "{log}");
        }
    }
    #[test]
    fn gpu_memory_resolution_budget_and_reservations_limit_concurrency() {
        let per = estimate_mib(Some((2896,1876)));
        assert_eq!(per, 1010);
        let reading = Reading {free_mib:1304,total_mib:8192};
        assert_eq!(reading.limit(per),1);
        assert_eq!(Reading{free_mib:100,total_mib:8192}.limit(per),0);
        let gpu = device_of(&json!({"id":"pci:0000:01:00.0","kind":"nvidia","index":0}));
        let gate = Arc::new(Gate::new(Arc::new(move |_| Some(reading))));
        let one = gate.try_reserve(&gpu, per, false).unwrap();
        assert!(gate.try_reserve(&gpu, per, false).is_none());
        drop(one);
        assert!(gate.try_reserve(&gpu, per, false).is_some());
    }
    #[test]
    fn gpu_memory_unavailable_keeps_limits_but_pressure_serializes() {
        let gpu = device_of(&json!({"id":"pci:0000:01:00.0","kind":"nvidia","index":0}));
        let gate = Arc::new(Gate::new(Arc::new(|_| None)));
        let one = gate.try_reserve(&gpu, 1000, false).unwrap();
        let two = gate.try_reserve(&gpu, 1000, false).unwrap();
        gate.pressure(&gpu);
        assert!(gate.try_reserve(&gpu,1000,true).is_none());
        drop(one); drop(two);
        let retry = gate.try_reserve(&gpu,1000,true).unwrap();
        assert!(gate.try_reserve(&gpu,1000,false).is_none());
        drop(retry);
    }

    #[test]
    fn gpu_memory_serial_waiters_are_fifo_and_release_admission_on_drop() {
        let gpu = device_of(&json!({"id":"pci:0000:01:00.0","kind":"nvidia"}));
        let other = device_of(&json!({"id":"pci:0000:02:00.0","kind":"nvidia"}));
        let gate = Arc::new(Gate::new(Arc::new(|_| None)));
        let busy = gate.try_reserve(&gpu,1000,false).unwrap();
        let first = gate.wait_serial(&gpu);
        let second = gate.wait_serial(&gpu);
        assert!(gate.try_reserve(&gpu,1000,false).is_none());
        assert!(gate.try_reserve(&other,1000,false).is_some(), "another device is independent");
        assert!(first.try_reserve(1000).is_none());
        drop(busy);
        assert!(second.try_reserve(1000).is_none(), "a newer retry cannot overtake its predecessor");
        let running = first.try_reserve(1000).unwrap();
        drop(first);
        assert!(second.try_reserve(1000).is_none(), "a retry runs alone even after its wait registration ends");
        drop(running);
        // Cancellation/pause while waiting must remove the reservation, not
        // leave an invisible serial gate permanently blocking this device.
        drop(second);
        assert!(!gate.draining(&gpu));
        assert!(gate.try_reserve(&gpu,1000,false).is_some());
    }
}
