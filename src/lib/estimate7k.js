const DAY_MS=86400000;
const dateKeyInSantiago=value=>{
 const d=value instanceof Date?value:new Date(value);
 if(!Number.isFinite(d.getTime()))return "";
 const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Santiago",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
 const get=t=>parts.find(p=>p.type===t)?.value||"";
 return get("year")+"-"+get("month")+"-"+get("day");
};
const addDays=(key,delta)=>{
 const [y,m,d]=key.split("-").map(Number);
 const x=new Date(Date.UTC(y,m-1,d+delta));
 return x.toISOString().slice(0,10);
};
const dayOrdinal=key=>{
 const [y,m,d]=key.split("-").map(Number);
 return Date.UTC(y,m-1,d)/DAY_MS;
};
const runDayKey=r=>{
 const local=r?.detail?.start_date_local;
 if(typeof local==="string"&&/^\d{4}-\d{2}-\d{2}/.test(local))return local.slice(0,10);
 const value=r?.run_date;
 if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
 return dateKeyInSantiago(value);
};
export const recentSevenDayRuns=(runs,now=Date.now())=>{
 const today=dateKeyInSantiago(now),first=addDays(today,-6);
 if(!today)return [];
 return (Array.isArray(runs)?runs:[]).filter(r=>{
  const key=runDayKey(r),km=Number(r.distance_km),duration=Number(r.duration_seconds);
  return key>=first&&key<=today&&Number.isFinite(km)&&km>=1&&km<=42&&Number.isFinite(duration)&&duration>=60&&duration<=21600;
 });
};
const median=values=>{
 const sorted=[...values].sort((a,b)=>a-b);
 if(!sorted.length)return 0;
 const mid=Math.floor(sorted.length/2);
 return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
};
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const streamAverage=(arr)=>{
 const values=Array.isArray(arr)?arr.map(Number).filter(v=>Number.isFinite(v)&&v>0):[];
 return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
};
export const estimateSevenK=(runs,now=Date.now())=>{
 const week=recentSevenDayRuns(runs,now);
 if(!week.length)return null;
 const today=dateKeyInSantiago(now),todayOrdinal=dayOrdinal(today);
 const candidates=week.map(r=>{
  const km=Number(r.distance_km),detail=r.detail||{},streams=detail.streams||{};
  const moving=Number(detail.moving_time)>0?Number(detail.moving_time):Number(r.duration_seconds);
  const elapsed=Math.max(moving,Number(detail.elapsed_time)||Number(r.elapsed_seconds)||moving);
  const paceSec=moving/km,source=String(r.source||"manual");
  const importedRpe=Number(detail.raw_summary?.perceived_exertion),storedRpe=Number(r.difficulty);
  const rpe=source==="strava"?(Number.isFinite(importedRpe)&&importedRpe>=1&&importedRpe<=10?importedRpe:null):(Number.isFinite(storedRpe)&&storedRpe>=1&&storedRpe<=10?storedRpe:null);
  const hr=Number(r.average_heartrate)>0?Number(r.average_heartrate):streamAverage(streams.heartrate?.data);
  const elevation=Number(r.total_elevation_gain)>0?Number(r.total_elevation_gain):0;
  const cadence=Number(r.average_cadence)||streamAverage(streams.cadence?.data);
  const gps=!!(r.summary_polyline||streams.latlng?.data?.length);
  const grade=Array.isArray(streams.grade_smooth?.data)?streams.grade_smooth.data.map(Number).filter(Number.isFinite):[];
  const gradeMean=grade.length?grade.reduce((a,b)=>a+b,0)/grade.length:0;
  const key=runDayKey(r),ageDays=Math.max(0,todayOrdinal-dayOrdinal(key));
  return {run:r,km,moving,elapsed,paceSec,rpe,hr,elevation,cadence,gps,gradeMean,key,ageDays,source,hasStreams:Object.keys(streams).length>0};
 }).filter(c=>Number.isFinite(c.paceSec)&&c.paceSec>=150&&c.paceSec<=1080&&c.km>=5);
 // Una carrera corta acredita velocidad, no resistencia suficiente para proyectar 7 km.
 // Exigimos al menos una referencia de 5 km y nunca extrapolamos desde 2–4,9 km.
 if(!candidates.length)return null;
 const maxDistance=Math.max(...candidates.map(c=>c.km));
 const longest=candidates.filter(c=>c.km>=maxDistance-0.01);
 const projections=longest.map(c=>c.moving*Math.pow(7/c.km,1.06));
 const projected=projections.reduce((a,b)=>a+b,0)/projections.length;
 const spread=projections.length>1?Math.sqrt(projections.reduce((a,v)=>a+Math.pow(v-projected,2),0)/projections.length):0;
 const hrRuns=candidates.filter(c=>c.hr>0),rpeRuns=candidates.filter(c=>c.rpe!==null);
 const confidence=maxDistance>=10?"Alta":maxDistance>=7?"Media":"Inicial";
 const detailScore=candidates.reduce((a,c)=>a+(c.hr>0?1:0)+(c.elevation>0?1:0)+(c.cadence>0?1:0)+(c.gps?1:0)+(c.hasStreams?1:0),0)/(candidates.length*5);
 return {conservative:Math.round(projected),pace:Math.round(projected/7),base:Math.round(projected),count:week.length,used:longest.length,excluded:week.length-candidates.length,adjustedOutliers:0,confidence,spread:Math.round(spread),bestCoverage:maxDistance,avgRpe:rpeRuns.length?rpeRuns.reduce((a,c)=>a+c.rpe,0)/rpeRuns.length:null,avgHr:hrRuns.length?hrRuns.reduce((a,c)=>a+c.hr,0)/hrRuns.length:0,avgElevation:candidates.reduce((a,c)=>a+c.elevation,0)/candidates.length,gpsCount:candidates.filter(c=>c.gps).length,detailScore,from:addDays(today,-6),to:today,runs:week,candidates:longest,referencePace:longest.reduce((a,c)=>a+c.paceSec,0)/longest.length};
};
