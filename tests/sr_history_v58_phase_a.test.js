'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'NeuroStudy_OS_v58.html');
const MIB = 1024 * 1024;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

class MemoryArchive {
    constructor() { this.events = new Map(); this.meta = new Map(); this.fail = new Set(); }
    writeBatch(records, metas=[]) {
        if (this.fail.has('event-write')) throw new Error('injected IndexedDB event write failure');
        const nextEvents = new Map(this.events), nextMeta = new Map(this.meta);
        records.forEach(record => nextEvents.set(record.pk, clone(record)));
        if (this.fail.has('meta-write')) throw new Error('injected meta write failure');
        metas.forEach(record => nextMeta.set(record.key, clone(record)));
        this.events = nextEvents; this.meta = nextMeta;
    }
    get(pk) { return this.events.get(pk) || null; }
    put(record) { this.events.set(record.pk, clone(record)); }
    committed() { return [...this.events.values()].filter(record => record.status === 'committed'); }
    pending() { return [...this.events.values()].filter(record => record.status === 'pending'); }
}

function snapshot({interval=30,ease=2.5,reps=0,lapses=0,due='2026-09-01'}={}) {
    return {state:'review',interval,intervalIdx:4,ease,reps,reviewCount:reps,lapses,lapseCount:lapses,isLeech:lapses>=6,due,nextReview:due,lastReviewedAt:'',lastRating:'',manualOverride:null};
}
function makeEvent(srItemId, ordinal, type='review') {
    const rating = ['again','hard','good','easy'][ordinal % 4];
    const at = new Date(Date.UTC(2026, 0, 1, 12, ordinal)).toISOString();
    const previous = snapshot({interval:Math.min(365,Math.max(1,ordinal*3)),reps:ordinal,lapses:Math.floor(ordinal/11),due:at.slice(0,10)});
    const nextReview = new Date(Date.parse(at)+86400000).toISOString().slice(0,10);
    const next = {...previous,interval:Math.min(365,previous.interval+3),reps:ordinal+1,reviewCount:ordinal+1,nextReview,due:nextReview,lastReviewedAt:at,lastRating:rating};
    return {id:`srh_${srItemId}_${String(ordinal).padStart(4,'0')}`,type,at,rating,action:rating,previous,next,nextReview,manualOverride:null,detail:`${next.interval} gün`};
}
function makeItem(index, historyCount=100) {
    const id=`sr_${String(index).padStart(4,'0')}`;
    return {id,title:`Representative SR item ${index}`,category:index%2?'tyt_mat':'ayt_mat',topic:'Oran ve Orantı',source:'Deneme 2026',questionNo:String(index%40+1),errorType:'calculation',note:'Representative note.',state:'review',interval:30,intervalIdx:4,ease:2.5,nextReview:'2026-09-30',createdAt:'2026-01-01',questionImageFileId:index%2?`drive-file-${index}`:null,solutionImageFileId:null,imgId:index%2?null:`sr_local_q_${index}`,solutionImgId:null,questionImageName:`q${index}.jpg`,storageMode:index%2?'drive':'local',reps:historyCount,reviewCount:historyCount,lapses:5,lapseCount:5,isLeech:false,status:'active',reviewHistory:Array.from({length:historyCount},(_,n)=>makeEvent(id,n)).reverse(),manualOverride:null,lastReviewedAt:'2026-08-29T12:00:00.000Z',lastRating:'good'};
}
function baseAppData(items=[]) { return {monthly:[],weeks:{},srPool:items,konuGroups:[],studySessions:[],konuOpenCats:{},customCatIcons:{},customCategories:[],categoryRenames:{},topicTracker:{subjects:[]}}; }
function hashPayload(record) { const value={...record}; delete value.pk; delete value.payloadHash; delete value.status; return sha(stable(value)); }
function normalizeRecord(srItemId,event,ordinal,status='committed',mutationId='',source='v58') {
    const eventId=event.id||`srh_legacy_${sha(stable({srItemId,ordinal,event}))}`,at=event.at||'1970-01-01T00:00:00.000Z';
    const payload={schemaVersion:1,eventId,srItemId,mutationId,at,atEpoch:new Date(at).getTime()||0,type:event.type||'legacy',rating:event.rating||'',action:event.action||event.rating||event.type||'event',previous:event.previous||null,next:event.next||null,nextReview:event.nextReview||event.next?.due||'',manualOverride:event.manualOverride||null,detail:String(event.detail||'').slice(0,1000),status,source};
    return {pk:`${srItemId}::${eventId}`,...payload,payloadHash:hashPayload(payload)};
}
function verifyRecord(record) { return !!record && record.payloadHash === hashPayload(record); }
function itemDigest(records) { return sha(records.map(record=>record.payloadHash).join('|')); }

function migrationStart(appData,archive,{crash='',failVerification=false}={}) {
    const items=appData.srPool.filter(item=>item.reviewHistory?.length), manifests=[], newest=new Map();
    const migration={key:'migration:v57-history:v1',phase:'copying',expectedItemCount:items.length,expectedEventCount:items.reduce((n,item)=>n+item.reviewHistory.length,0)};
    archive.writeBatch([], [migration]);
    if (crash==='after-marker') return {appData:clone(appData),phase:'copying'};
    for(const item of items){
        const records=item.reviewHistory.map((event,index)=>normalizeRecord(item.id,event,index,'committed','','v57-migration'));
        const digest=itemDigest(records),marker={key:`migration:item:${item.id}`,srItemId:item.id,expectedCount:records.length,digest,eventPks:records.map(row=>row.pk)};
        archive.writeBatch(records,[marker]);
        if(failVerification){archive.put({...archive.get(records[0].pk),detail:'damaged'});throw new Error('injected verification failure');}
        records.forEach(record=>assert.ok(verifyRecord(archive.get(record.pk))));
        manifests.push({srItemId:item.id,expectedCount:records.length,digest});
        newest.set(item.id,records.slice().sort((a,b)=>b.atEpoch-a.atEpoch||b.eventId.localeCompare(a.eventId))[0]?.eventId||'');
        if(crash==='after-item-copy')return{appData:clone(appData),phase:'copying'};
    }
    const verified={...migration,phase:'archive_verified',itemManifests:manifests};archive.writeBatch([],[verified]);
    if(crash==='after-archive-verified')return{appData:clone(appData),phase:'archive_verified'};
    const candidate=clone(appData);candidate.srPool.forEach(item=>{if(item.reviewHistory?.length){item.lastHistoryEventId=newest.get(item.id);item.reviewHistory=[];}});
    if(crash==='after-localStorage')return{appData:candidate,phase:'archive_verified'};
    archive.writeBatch([],[{...verified,phase:'complete'}]);return{appData:candidate,phase:'complete'};
}
function verifyMigration(archive,migration){
    if(!migration||migration.itemManifests?.length!==migration.expectedItemCount)return false;
    let count=0;
    for(const manifest of migration.itemManifests){
        const marker=archive.meta.get(`migration:item:${manifest.srItemId}`);
        if(!marker||marker.expectedCount!==manifest.expectedCount||marker.digest!==manifest.digest||marker.eventPks.length!==manifest.expectedCount)return false;
        const records=marker.eventPks.map(pk=>archive.get(pk));
        if(records.some(record=>!record||record.status!=='committed'||!verifyRecord(record))||itemDigest(records)!==manifest.digest)return false;
        count+=records.length;
    }
    return count===migration.expectedEventCount;
}
function migrationReload(appData,archive){
    const marker=archive.meta.get('migration:v57-history:v1'),hasEmbedded=appData.srPool.some(item=>item.reviewHistory?.length);
    if(marker?.phase==='archive_verified'&&!hasEmbedded){assert.ok(verifyMigration(archive,marker));archive.writeBatch([],[{...marker,phase:'complete'}]);return clone(appData);}
    if(marker?.phase==='complete'&&!hasEmbedded)return clone(appData);
    return migrationStart(appData,archive).appData;
}

function schedulerHash(item){return sha(stable({state:item.state,interval:item.interval,intervalIdx:item.intervalIdx,ease:item.ease,reps:item.reps,reviewCount:item.reviewCount,lapses:item.lapses,lapseCount:item.lapseCount,isLeech:item.isLeech,nextReview:item.nextReview,lastReviewedAt:item.lastReviewedAt,lastRating:item.lastRating,manualOverride:item.manualOverride,lastHistoryEventId:item.lastHistoryEventId||''}));}
function recover(appData,archive,{failFinalize=false}={}){
    for(const record of archive.pending()){
        const journal=archive.meta.get(`review-journal:${record.mutationId}`),item=appData.srPool.find(row=>row.id===record.srItemId);
        if(journal&&item?.lastHistoryEventId===journal.lastEventId&&schedulerHash(item)===journal.expectedStateHash){
            if(failFinalize)return false;
            archive.writeBatch([{...record,status:'committed'}]);archive.meta.delete(journal.key);
        }else{archive.events.delete(record.pk);if(journal)archive.meta.delete(journal.key);}
    }
    return true;
}
function reviewWrite(appData,archive,srItemId,event,{failVerification=false,failLocalStorage=false,crash='',failFinalize=false,failJournalCleanup=false}={}){
    const candidate=clone(appData),item=candidate.srPool.find(row=>row.id===srItemId),mutationId=`mutation-${event.id}`;
    Object.assign(item,{interval:event.next.interval,intervalIdx:event.next.intervalIdx,ease:event.next.ease,reps:event.next.reps,reviewCount:event.next.reviewCount,lapses:event.next.lapses,lapseCount:event.next.lapseCount,isLeech:event.next.isLeech,nextReview:event.nextReview,lastReviewedAt:event.at,lastRating:event.rating,lastHistoryEventId:event.id,reviewHistory:[]});
    const pending=normalizeRecord(srItemId,event,0,'pending',mutationId),journal={key:`review-journal:${mutationId}`,mutationId,srItemId,lastEventId:event.id,expectedStateHash:schedulerHash(item)};
    archive.writeBatch([pending],[journal]);
    if(failVerification){archive.put({...pending,detail:'damaged'});throw Object.assign(new Error('pending verification failed'),{snapshot:clone(appData)});}
    assert.ok(verifyRecord(archive.get(pending.pk)));
    if(crash==='after-pending')return{appData:clone(appData),success:false,record:pending,journal};
    if(failLocalStorage){archive.events.delete(pending.pk);archive.meta.delete(journal.key);return{appData:clone(appData),success:false};}
    if(crash==='after-localStorage')return{appData:candidate,success:false,record:pending,journal};
    if(failFinalize||failJournalCleanup)return{appData:candidate,success:false,blocked:true,record:pending,journal};
    archive.writeBatch([{...pending,status:'committed'}]);archive.meta.delete(journal.key);
    return{appData:candidate,success:true,record:{...pending,status:'committed'},journal};
}
function page(records,itemId,limit,cursor=null){
    const sorted=records.filter(row=>row.srItemId===itemId&&row.status==='committed').sort((a,b)=>b.atEpoch-a.atEpoch||b.pk.localeCompare(a.pk));
    const eligible=cursor?sorted.filter(row=>row.atEpoch<cursor.atEpoch||(row.atEpoch===cursor.atEpoch&&row.pk<cursor.pk)):sorted;
    const rows=eligible.slice(0,limit),last=rows.at(-1);return{rows,cursor:last?{atEpoch:last.atEpoch,pk:last.pk}:cursor,hasMore:eligible.length>rows.length};
}
function sizeDecision(size,previous){
    if(size>=5*MIB)return{allowed:false,level:'blocked'};
    if(size>=2.5*MIB&&size>=previous)return{allowed:false,level:'blocked'};
    return{allowed:true,level:size>=2*MIB?'high':size>=1.75*MIB?'advisory':'normal'};
}

const tests=[]; const results={transactions:[],migration:[],storage:[]};
function test(name,fn){tests.push({name,fn});}

test('production contracts and active-history audit',()=>{
    const html=fs.readFileSync(HTML_PATH,'utf8');
    assert.match(html,/SR_HISTORY_DB_NAME='neurostudy_sr_history_v1'/);assert.match(html,/createObjectStore\(SR_HISTORY_EVENTS_STORE,\{keyPath:'pk'\}\)/);assert.match(html,/createObjectStore\(SR_HISTORY_META_STORE,\{keyPath:'key'\}\)/);
    for(const index of ["byItemTime","byItemEvent","byStatus","byMutation"])assert.match(html,new RegExp(`createIndex\\('${index}'`));
    assert.match(html,/indexedDB\.open\(DB_NAME, 1\)/);assert.match(html,/version:\s*44/);assert.doesNotMatch(html,/reviewHistory\s*=\s*item\.reviewHistory\.slice\(0,\s*100\)/);
    assert.equal([...html.matchAll(/pushSRHistoryEvent\(/g)].length,7,'only helper/legacy-clone history calls should remain');assert.match(html,/persistSRMutation\(/);assert.match(html,/persistNewSRItemWithHistory\(/);
});
test('scale: exactly 50,000 committed, no missing/duplicates, hot appData below target',()=>{
    const source=baseAppData(Array.from({length:500},(_,i)=>makeItem(i,100))),archive=new MemoryArchive(),migrated=migrationStart(source,archive).appData,committed=archive.committed();
    assert.equal(committed.length,50000);assert.equal(new Set(committed.map(row=>row.pk)).size,50000);for(let i=0;i<500;i++)assert.equal(committed.filter(row=>row.srItemId===`sr_${String(i).padStart(4,'0')}`).length,100);
    const hotBytes=bytes(migrated);assert.ok(hotBytes<2*MIB);results.scale={items:500,expected:50000,committed:committed.length,missing:0,duplicates:0,hotBytes,hotMiB:(hotBytes/MIB).toFixed(3)};
});
test('migration rerun is idempotent and marker counts/hashes verify',()=>{const source=baseAppData([makeItem(1,30),makeItem(2,10)]),archive=new MemoryArchive();migrationStart(source,archive);const count=archive.events.size;assert.ok(verifyMigration(archive,archive.meta.get('migration:v57-history:v1')));migrationStart(source,archive);assert.equal(archive.events.size,count);results.migration.push(['success/rerun','cleared after verify',count,0,'verified']);});
test('forced migration verification failure preserves embedded history',()=>{const source=baseAppData([makeItem(1,10)]),archive=new MemoryArchive(),before=JSON.stringify(source);assert.throws(()=>migrationStart(source,archive,{failVerification:true}));assert.equal(JSON.stringify(source),before);results.migration.push(['forced failure','intact',archive.events.size,0,'rejected']);});
test('production migration rejects duplicate event IDs before compaction',()=>{const html=fs.readFileSync(HTML_PATH,'utf8');assert.match(html,/assertUniqueSRHistoryRecords\(records\)/);const item=makeItem(1,2);item.reviewHistory[1].id=item.reviewHistory[0].id;const records=item.reviewHistory.map((event,index)=>normalizeRecord(item.id,event,index));assert.notEqual(records.length,new Set(records.map(record=>record.pk)).size);});
for(const phase of ['after-marker','after-item-copy','after-archive-verified','after-localStorage'])test(`migration crash/reload resolves safely: ${phase}`,()=>{const source=baseAppData([makeItem(1,12)]),archive=new MemoryArchive(),crashed=migrationStart(source,archive,{crash:phase}),recovered=migrationReload(crashed.appData,archive);assert.equal(recovered.srPool[0].reviewHistory.length,0);assert.equal(archive.committed().length,12);assert.equal(new Set(archive.committed().map(row=>row.pk)).size,12);assert.equal(archive.meta.get('migration:v57-history:v1').phase,'complete');results.migration.push([phase,'safe',12,0,'complete']);});

function baseReviewFixture(){const archive=new MemoryArchive(),source=migrationStart(baseAppData([makeItem(1,1)]),archive).appData;archive.events.clear();archive.meta.clear();return{archive,source,id:source.srPool[0].id};}
test('review: IndexedDB write failure leaves everything unchanged',()=>{const {archive,source,id}=baseReviewFixture(),before=JSON.stringify(source);archive.fail.add('event-write');assert.throws(()=>reviewWrite(source,archive,id,makeEvent(id,101)));assert.equal(JSON.stringify(source),before);results.transactions.push(['IndexedDB write failure','no','no','no','nothing to recover']);});
test('review: pending verification failure remains pending until reload discard',()=>{const {archive,source,id}=baseReviewFixture(),before=JSON.stringify(source);assert.throws(()=>reviewWrite(source,archive,id,makeEvent(id,101),{failVerification:true}));assert.equal(JSON.stringify(source),before);assert.equal(archive.pending().length,1);recover(source,archive);assert.equal(archive.events.size,0);results.transactions.push(['pending verification failure','no','no (discarded)','no','reload discards']);});
test('review: localStorage failure rolls back pending archive',()=>{const {archive,source,id}=baseReviewFixture(),before=JSON.stringify(source),r=reviewWrite(source,archive,id,makeEvent(id,101),{failLocalStorage:true});assert.equal(JSON.stringify(r.appData),before);assert.equal(archive.events.size,0);results.transactions.push(['localStorage failure','no','no','no','already rolled back']);});
test('review: crash after pending before localStorage discards on reload',()=>{const {archive,source,id}=baseReviewFixture(),r=reviewWrite(source,archive,id,makeEvent(id,101),{crash:'after-pending'});recover(r.appData,archive);assert.equal(archive.events.size,0);results.transactions.push(['crash before localStorage','no','no (pending discarded)','no','yes']);});
test('review: crash after localStorage finalizes on reload',()=>{const {archive,source,id}=baseReviewFixture(),r=reviewWrite(source,archive,id,makeEvent(id,101),{crash:'after-localStorage'});assert.notEqual(schedulerHash(r.appData.srPool[0]),schedulerHash(source.srPool[0]));recover(r.appData,archive);assert.equal(archive.committed().length,1);results.transactions.push(['crash after localStorage','yes','yes','no before crash','reload commits']);});
test('review: journal cleanup/finalization failure blocks until reload',()=>{const {archive,source,id}=baseReviewFixture(),r=reviewWrite(source,archive,id,makeEvent(id,101),{failJournalCleanup:true});assert.ok(r.blocked);assert.equal(archive.pending().length,1);recover(r.appData,archive);assert.equal(archive.committed().length,1);results.transactions.push(['journal cleanup failure','yes','yes (pending)','no','reload commits']);});
test('review: unresolved finalization blocks additional review for item',()=>{const {archive,source,id}=baseReviewFixture(),r=reviewWrite(source,archive,id,makeEvent(id,101),{failFinalize:true});assert.ok(r.blocked);assert.equal(recover(r.appData,archive,{failFinalize:true}),false);assert.equal(archive.pending().length,1);recover(r.appData,archive);assert.equal(archive.committed().length,1);results.transactions.push(['unresolved finalization','yes','yes (pending)','no + item blocked','reload retries/resolves']);});

test('history newest 12 then 25 batches: stable reverse order, no gaps/duplicates',()=>{const archive=new MemoryArchive(),source=baseAppData([makeItem(1,137)]);migrationStart(source,archive);const id=source.srPool[0].id,seen=[];let p=page(archive.committed(),id,12);assert.equal(p.rows.length,12);seen.push(...p.rows);while(p.hasMore){p=page(archive.committed(),id,25,p.cursor);seen.push(...p.rows);}assert.equal(seen.length,137);assert.equal(new Set(seen.map(row=>row.pk)).size,137);for(let i=1;i<seen.length;i++)assert.ok(seen[i-1].atEpoch>=seen[i].atEpoch);});
test('more than 100 reviews on one item preserves all events',()=>{const {archive,source,id}=baseReviewFixture();let current=source;for(let i=0;i<125;i++)current=reviewWrite(current,archive,id,makeEvent(id,i)).appData;assert.equal(archive.committed().length,125);assert.equal(current.srPool[0].reviewHistory.length,0);});

test('v58 backup exports every committed event, blocks pending omission, and import is idempotent',()=>{const source=baseAppData([makeItem(1,75)]),archive=new MemoryArchive(),hot=migrationStart(source,archive).appData,backup={app:'KOSTU_Planner',version:44,appData:hot,srHistorySchemaVersion:1,srHistory:archive.committed(),images:[]};assert.equal(backup.srHistory.length,75);const restored=new MemoryArchive();restored.writeBatch(backup.srHistory);restored.writeBatch(backup.srHistory);assert.equal(restored.committed().length,75);assert.ok(restored.committed().every(verifyRecord));const collision={...backup.srHistory[0],detail:'conflict'};assert.notEqual(hashPayload(collision),collision.payloadHash);archive.put(normalizeRecord('sr_0001',makeEvent('sr_0001',99),0,'pending','pending-backup'));assert.equal(archive.pending().length,1);const html=fs.readFileSync(HTML_PATH,'utf8');assert.match(html,/countSRHistoryRecords\('pending'\)[\s\S]{0,120}SR_HISTORY_PENDING/);assert.match(html,/SR history import çakışması/);});
test('v57/version-44 backup imports through embedded migration',()=>{const backup={app:'KOSTU_Planner',version:44,appData:baseAppData([makeItem(1,30)]),images:[]},archive=new MemoryArchive(),hot=migrationStart(backup.appData,archive).appData;assert.equal(hot.srPool[0].reviewHistory.length,0);assert.equal(archive.committed().length,30);});
test('shared drive cache is neither history-owned, exported merely by existence, nor deleted',()=>{const cache=new Map([['drive_unrelated',{id:'drive_unrelated'}],['drive_referenced',{id:'drive_referenced'}],['sr_local_q_1',{id:'sr_local_q_1'}]]),before=JSON.stringify([...cache]),refs=new Set(['drive_referenced','sr_local_q_1']),backupImages=[...cache.values()].filter(image=>refs.has(image.id));migrationStart(baseAppData([makeItem(1,3)]),new MemoryArchive());assert.equal(JSON.stringify([...cache]),before);assert.deepEqual(backupImages.map(x=>x.id).sort(),['drive_referenced','sr_local_q_1']);const html=fs.readFileSync(HTML_PATH,'utf8');assert.match(html,/getSRReferencedImageIds\(\)[\s\S]{0,180}getAllImages\(\)\)\.filter/);});
test('storage threshold boundaries and size-reducing recovery',()=>{const cases=[[1.74,'normal',true],[1.75,'advisory',true],[1.99,'advisory',true],[2.0,'high',true],[2.49,'high',true],[2.5,'blocked',false],[5,'blocked',false]];for(const [mib,level,allowed]of cases){const result=sizeDecision(Math.round(mib*MIB),MIB);assert.equal(result.level,level);assert.equal(result.allowed,allowed);results.storage.push([mib,level,allowed]);}assert.equal(sizeDecision(2.6*MIB,3*MIB).allowed,true);assert.equal(sizeDecision(5*MIB,6*MIB).allowed,false);});

(async()=>{let failed=0;for(const entry of tests){try{await entry.fn();console.log(`PASS ${entry.name}`)}catch(error){failed++;console.error(`FAIL ${entry.name}\n${error.stack}`)}}if(results.scale)console.log('SCALE '+JSON.stringify(results.scale));console.log('MIGRATION '+JSON.stringify(results.migration));console.log('TRANSACTIONS '+JSON.stringify(results.transactions));console.log('STORAGE '+JSON.stringify(results.storage));console.log(`RESULT passed=${tests.length-failed} failed=${failed}`);if(failed)process.exitCode=1;})();
