const assert = require('node:assert/strict');
const test = require('node:test');
const { PNG } = require('pngjs');
const { RainRadar, radarTile, readRadarPixel, radarReflectivity, parseRadarFrames, evaluateRadar } = require('../.homeybuild/lib/rainRadar');
const minute = 60_000;
const now = Date.UTC(2026, 8, 23, 12);
const config = { enabled:true, threshold:15, dryingMinutes:120 };
const dry = (count=13, end=now) => Array.from({length:count}, (_,i)=>({time:end-(count-1-i)*10*minute,dbz:-32}));
const image = (hex='00000000', x=0, y=0) => {
  const png = new PNG({width:256,height:256});
  Buffer.from(hex,'hex').copy(png.data,(y*256+x)*4);
  return PNG.sync.write(png);
};
const manifest = (points=dry()) => Buffer.from(JSON.stringify({host:'https://tilecache.rainviewer.com',radar:{past:points.map(p=>({time:p.time/1000,path:'/v2/radar/abc'+p.time}))}}));

test('Mercator tile calculation uses the home pixel, handles equator and longitude wrap',()=>{
  assert.deepEqual(radarTile({latitude:0,longitude:0}),{x:64,y:64,px:0,py:0,key:'7/64/64/0/0'});
  assert.equal(radarTile({latitude:0,longitude:180}).x,0);
  assert.throws(()=>radarTile({latitude:NaN,longitude:0}));
  assert.throws(()=>radarTile({latitude:90,longitude:0}));
});
test('unsmoothed palette decodes dry, weak echoes, threshold and heavy rain',()=>{
  for(const [hex,value] of [['00000000',-32],['92887164',5],['ded097be',14],['88ddeeff',15],['00a3e0ff',20],['ff4400ff',45],['ffffffff',65],['00ff00ff',75]]) {
    assert.equal(radarReflectivity(readRadarPixel(image(hex,10,20),{px:10,py:20})),value);
  }
  assert.throws(()=>radarReflectivity(Buffer.from('010203ff','hex')),/palette/);
});
test('neighbouring rain does not turn the home pixel into rain',()=>{
  assert.equal(radarReflectivity(readRadarPixel(image('ff4400ff',1,0),{px:0,py:0})),-32);
});
test('malformed, wrong-size and bad-CRC PNGs are rejected',()=>{
  assert.throws(()=>readRadarPixel(Buffer.from('not PNG'),{px:0,py:0}));
  const huge=image(); huge.writeUInt32BE(100000,16);
  assert.throws(()=>readRadarPixel(huge,{px:0,py:0}),/Invalid/);
  const corrupt=image(); corrupt[29]^=255;
  assert.throws(()=>readRadarPixel(corrupt,{px:0,py:0}));
});
test('manifest accepts actual hashed paths but rejects stale/future/duplicate/host-injection data',()=>{
  const data=JSON.parse(manifest());
  assert.equal(parseRadarFrames(data,now).length,13);
  for(const alter of [d=>d.host='https://evil.example',d=>d.radar.past[0].path='/v2/radar/../../secret',d=>d.radar.past.push(d.radar.past[0]),d=>d.radar.past[0].time=(now+5*minute)/1000]) {
    const clone=structuredClone(data); alter(clone); assert.throws(()=>parseRadarFrames(clone,now));
  }
  assert.throws(()=>parseRadarFrames(data,now+21*minute));
});
test('two hours of observed dryness allow mowing immediately, including after restart',()=>{
  assert.equal(evaluateRadar(dry(),config,now).state,'dry');
  assert.equal(evaluateRadar(dry(),config,now+19*minute).state,'dry');
});
test('rain is detected without needing dry history; weak subthreshold echoes are not rain',()=>{
  assert.equal(evaluateRadar([{time:now,dbz:15}],config,now).state,'rain');
  assert.equal(evaluateRadar(dry().map(p=>({...p,dbz:14})),config,now).state,'dry');
});
test('drying starts at the first dry frame after rain, not the last wet frame',()=>{
  const points=[{time:now-20*minute,dbz:30},...dry(2)];
  assert.equal(evaluateRadar(points,config,now).state,'drying');
  assert.equal(evaluateRadar(points,config,now).remainingMinutes,110);
  assert.equal(evaluateRadar([{time:now-130*minute,dbz:30},...dry()],config,now).state,'dry');
});
test('stale/absent data are unknown, never rain or permission to mow',()=>{
  for(const points of [[],dry(13,now-21*minute),[{time:now+5*minute,dbz:40}]]) {
    assert.equal(evaluateRadar(points,config,now).state,'unknown');
  }
  assert.equal(evaluateRadar([{time:now-21*minute,dbz:40}],config,now).state,'unknown');
});
test('an observation gap or elapsed wall time cannot fabricate two dry hours',()=>{
  const points=dry();points.splice(6,2);
  assert.equal(evaluateRadar(points,config,now).state,'unknown');
  assert.equal(evaluateRadar(dry(12),config,now+15*minute).state,'unknown');
  assert.equal(evaluateRadar(dry(),{...config,enabled:false},now).state,'disabled');
});
function harness(overrides={}) {
  let clock=now;
  const calls=[], published=[], errors=[];
  const radar=new RainRadar({config,location:()=>({latitude:0,longitude:0}),now:()=>clock,
    publish:async(s,h)=>published.push({s,h:structuredClone(h)}),error:e=>errors.push(e),
    download:async(url)=>{calls.push(url);return url.includes('weather-maps')?manifest():image()},...overrides});
  return {radar,calls,published,errors,advance:m=>clock+=m*minute};
}
test('initial poll checks coverage, loads history, caches tiles and coalesces concurrent polls',async()=>{
  const h=harness();h.radar.start();try {
    const first=h.radar.refresh();assert.equal(first,h.radar.refresh());await first;
    assert.equal(h.radar.snapshot().state,'dry');assert.equal(h.calls.length,15);
    await h.radar.refresh();assert.equal(h.calls.length,15);
    h.advance(5);await h.radar.refresh();assert.equal(h.calls.length,16);
  }finally{h.radar.stop()}
});
test('restart reuses persisted observations but rechecks coverage and manifest',async()=>{
  const h=harness({stored:{key:'7/64/64/0/0',points:dry()}});h.radar.start();try {
    await h.radar.refresh();assert.equal(h.radar.snapshot().state,'dry');assert.equal(h.calls.length,2);
  }finally{h.radar.stop()}
});
test('API errors do not invent rain; old dry evidence eventually expires',async()=>{
  const h=harness({stored:{key:'7/64/64/0/0',points:dry()},download:async()=>{throw Error('offline')}});
  h.radar.start();try {
    await h.radar.refresh();
    // Coverage has not been established in this instance: do not trust cached dryness.
    assert.equal(h.radar.snapshot().state,'unknown');
    h.advance(21);await h.radar.refresh();assert.equal(h.radar.snapshot().state,'unknown');
  }finally{h.radar.stop()}
});
test('location changes invalidate observations and uncoverable locations are not dry',async()=>{
  let location={latitude:0,longitude:0};
  const h=harness({location:()=>location});h.radar.start();try {
    await h.radar.refresh();assert.equal(h.radar.snapshot().state,'dry');
    location={latitude:NaN,longitude:0};await h.radar.refresh();assert.equal(h.radar.snapshot().state,'unknown');
  }finally{h.radar.stop()}
  const uncovered=harness({download:async()=>image('000000ff')});uncovered.radar.start();try {
    await uncovered.radar.refresh();assert.equal(uncovered.radar.snapshot().state,'unknown');
    assert.match(uncovered.radar.snapshot().detail,/coverage/);
  }finally{uncovered.radar.stop()}
});
test('stopping during a request prevents late publication and further tile downloads',async()=>{
  let finish;const h=harness({download:()=>new Promise(resolve=>{finish=resolve})});h.radar.start();
  const pending=h.radar.refresh();h.radar.stop();finish(image());
  // Coverage completion must not start a manifest request after stop.
  await pending;assert.equal(h.published.length,0);
});

test('disabling radar never downloads tiles or sends any commands',async()=>{
  const h=harness({config:{...config,enabled:false}});h.radar.start();try {
    await h.radar.refresh();assert.equal(h.calls.length,0);assert.equal(h.radar.snapshot().state,'disabled');
  }finally{h.radar.stop()}
});

test('a temporary outage preserves history and automatically recovers on a later poll',async()=>{
  let offline=false;
  const h=harness({download:async url=>{if(offline)throw Error('offline');return url.includes('weather-maps')?manifest():image()}});
  h.radar.start();try {
    await h.radar.refresh();assert.equal(h.radar.snapshot().state,'dry');
    offline=true;h.advance(5);await h.radar.refresh();assert.equal(h.radar.snapshot().state,'unknown');
    offline=false;await h.radar.refresh();assert.equal(h.radar.snapshot().state,'dry');
  }finally{h.radar.stop()}
});
