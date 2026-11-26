const test=require('node:test'); const assert=require('node:assert/strict');
const load=()=>import('../examples/ui-packs/sentry-six/web/s6/encoderModel.js');
test('read-only skips and proven source defects are not problems; unknown source failures stay failures',async()=>{
 const {clipFailures}=await load();
 const items=['source-duplicate-timestamp','source-nal-boundary','source-unfinished-sample-table','folder-not-writable'].map((resultCode,i)=>({state:'skipped',resultCode,relativePath:`generated-${i}.mp4`,...(i===3?{failure:{code:resultCode,retryable:true}}:{})}));
 const r=clipFailures({items}); assert.equal(r.kept,3); assert.equal(r.attention,0); assert.equal(r.items.length,3);
 assert.match(r.items[0].reason,/timestamp/i); assert.match(r.items[1].reason,/boundary/i); assert.match(r.items[2].reason,/sample table.*missing bytes/i);
 assert.equal(clipFailures({items:[{state:'failed',resultCode:'source-invalid',failure:{retryable:false}}]}).attention,1);
 assert.equal(clipFailures({items:[{state:'failed',resultCode:'invalid-h264',failure:{retryable:false}}]}).attention,1);
});
test('current run totals use the same classification as the attention sentence',async()=>{
 const {currentRunSummary}=await load();
 const snapshot={id:'new',state:'paused',items:[{state:'completed',resultCode:'converted'},{state:'skipped',resultCode:'source-nal-boundary'},{state:'skipped',resultCode:'folder-not-writable'},{state:'failed',resultCode:'encode-failed'}]};
 assert.equal(currentRunSummary(snapshot),'Current run: 1 converted, 2 skipped, 1 failed');
});
test('discovery skips show a bounded count and paths without becoming failed clips',async()=>{
 const {discoveryIssueText,currentRunSummary}=await load();
 assert.match(discoveryIssueText({count:2,examples:['SavedClips/generated: EIO']}),/2 paths.*SavedClips\/generated.*next run/i);
 assert.equal(discoveryIssueText({count:0,examples:[]}), '');
 assert.equal(currentRunSummary({itemCounts:{converted:4,skipped:2,failed:1}}),'Current run: 4 converted, 2 skipped, 1 failed');
});
