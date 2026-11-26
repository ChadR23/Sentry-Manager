//! Permission admission and a persisted, draining pause. A repaired folder is
//! rechecked before resuming; successful items are never re-queued.
use super::*;
use std::os::unix::fs::MetadataExt;
use super::super::folder_access;
const FOLDER_RESCAN:std::time::Duration=std::time::Duration::from_secs(300);
impl Service {
    pub(super) fn pause_for_folders(&self,rt:&Arc<Runtime>,report:&folder_access::Report)->SResult<()> {
        if !report.blocked(){return Ok(());}
        { let mut s=rt.lock(); s.pause_requested=true; }
        self.update(rt,|_|Some(Patch::new().set("permissionBlock",json!(report))))?;
        rt.cv.notify_all();
        Ok(())
    }
    pub(super) fn clear_folder_block(&self,rt:&Arc<Runtime>)->SResult<()> {
        rt.folder_checks.lock().unwrap().clear();
        *rt.folder_scan_at.lock().unwrap()=std::time::Instant::now();
        if rt.manifest().get("permissionBlock").is_none(){return Ok(());}
        let mut retry=vec![];
        self.update(rt,|s| {
            let items=s.manifest.items.iter().map(|i|if i.state()==ItemState::Skipped && i.str("resultCode")==Some("folder-not-writable") {
                retry.push(i.id().to_string());
                ItemIn::Raw(merge(i.value(),&vec![("state",Some(ItemState::Queued.into())),("failure",None),("resultCode",None)]))
            } else {ItemIn::Trusted(i.clone())}).collect();
            Some(Patch::new().set("permissionBlock",Value::Null).items(items))
        })?;
        let mut s=rt.lock();
        if s.running {for id in retry {if !s.queue.contains(&id){s.queue.push_back(id);}}}
        Ok(())
    }
    pub(super) fn folder_preflight(&self,rt:&Arc<Runtime>,item:&Value)->SResult<()> {
        let config=rt.lock().manifest.config().clone();
        // Catch new uploads elsewhere too, at most once every 5 minutes per
        // running job (a full walk lists every folder of the share). The
        // discovery walk also checks newly visited folders. The stamp is taken
        // before the walk so other workers never wait on it.
        let due={
            let mut last=rt.folder_scan_at.lock().unwrap();
            let due=last.elapsed()>=FOLDER_RESCAN;
            if due {*last=std::time::Instant::now();}
            due
        };
        if due {
            let report=folder_access::scan(&config);
            self.pause_for_folders(rt,&report)?;
        }
        let mut targets=vec![item["sourcePath"].as_str().unwrap_or("").to_string()];
        if config["outputMode"]!="replace" {targets.push(output_path(&config,item));}
        for target in targets {
        let folder=folder_access::existing_parent(Path::new(&target).parent().unwrap_or(Path::new(&target)));
        let stat=std::fs::metadata(&folder).ok();
        let stamp=stat.as_ref().map(|s|(s.ctime(),s.ctime_nsec())).unwrap_or((0,0));
        let mut cache=rt.folder_checks.lock().unwrap();
        let previous=cache.get(&folder).filter(|(sec,ns,_)|(*sec,*ns)==stamp);
        let error=if let Some((_,_,e))=previous {e.clone()} else {
            let e=folder_access::writable(&folder).err().filter(folder_access::denied).map(|e|format!("{}: {e}",folder_access::folder_detail(&folder)));
            cache.insert(folder.clone(),(stamp.0,stamp.1,e.clone()));e
        };
        drop(cache);
        if let Some(detail)=error {return Err(Fail{code:Some("FOLDER_NOT_WRITABLE".into()),retryable:true,detail:Some(detail),..Default::default()});}
        }
        Ok(())
    }
}
