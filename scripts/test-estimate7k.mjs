import assert from "node:assert/strict";
import {estimateSevenK} from "../src/lib/estimate7k.js";
const now=new Date("2026-11-01T12:00:00-03:00").getTime();
const date=(daysAgo)=>new Date(now-daysAgo*86400000).toISOString();
const make=(km,paceMin,rpe=7,hr=160,elevation=20,daysAgo=0,extra={})=>({
 distance_km:km,duration_seconds:Math.round(km*paceMin*60),difficulty:rpe,average_heartrate:hr,
 max_heartrate:hr?hr+15:null,total_elevation_gain:elevation,source:"manual",run_date:date(daysAgo),...extra
});
const scenarios=[
 {name:"Rendimiento equilibrado",runs:[make(5,6.5,8,165,40,0),make(4,6.75,6,150,25,1),make(3,7,5,145,15,2),make(6,7,8,170,55,3)]},
 {name:"Sin BPM ni desnivel",runs:[make(5,6.5,8,null,null,0),make(4,6.75,6,null,null,1),make(3,7,5,null,null,2),make(6,7,8,null,null,3)]},
 {name:"BPM muy bajos",runs:[make(5,6.5,8,92,30,0),make(4,6.75,6,88,15,1),make(3,7,5,85,0,2),make(6,7,8,95,45,3)]},
 {name:"Sin esfuerzo percibido",runs:[make(5,6.5,null,165,20,0),make(4,6.75,null,158,10,1),make(3,7,null,150,5,2),make(6,7,null,172,25,3)]},
 {name:"Sin BPM",runs:[make(5,6.5,7,null,80,0),make(4,6.75,7,null,0,1),make(3,7,6,null,25,2),make(6,7,8,null,100,3)]},
 {name:"Entrenamientos suaves",runs:[make(5,6.5,9,170,10,0),make(4,9,3,110,0,1),make(3,10,2,105,0,2),make(2,11,3,108,0,3)]},
 {name:"Esfuerzo alto",runs:[make(5,6.5,10,185,20,0),make(4,6.75,9,180,10,1),make(3,7,9,178,5,2),make(6,7,10,190,25,3)]},
 {name:"Mucho desnivel",runs:[make(5,6.5,7,165,150,0),make(4,6.75,7,160,120,1),make(3,7,6,155,80,2),make(6,7,8,170,200,3)]},
 {name:"5K rápido y recuperaciones muy lentas sin sensores",runs:[make(5,6.5,null,null,null,0),make(4,14,null,null,null,1),make(3,14,null,null,null,2),make(2,14,null,null,null,3)]},
 {name:"Sprint corto atípico",runs:[make(5,7,7,160,10,0),make(4,7.1,7,158,10,1),make(3,7.2,7,155,10,2),make(1,3.2,10,190,0,3)]}
];
for(const scenario of scenarios){
 const estimate=estimateSevenK(scenario.runs,now);
 assert.ok(estimate,scenario.name+" debe producir estimación");
 assert.equal(estimate.used,4,scenario.name+" debe usar las cuatro corridas");
 assert.ok(estimate.conservative>30*60&&estimate.conservative<90*60,scenario.name+" debe quedar en un rango razonable");
 console.log(scenario.name+" | "+Math.floor(estimate.conservative/60)+":"+String(estimate.conservative%60).padStart(2,"0")+" | "+(estimate.pace/60).toFixed(2)+" min/km | usadas "+estimate.used+"/4");
}
const recovery=estimateSevenK(scenarios[8].runs,now);
assert.ok(recovery.conservative<60*60,"Un 5K a 6:30 no debe quedar arrastrado a 1h40 por recuperaciones lentas");
const stale=estimateSevenK([...scenarios[0].runs,{...make(5,6.5,10,180,20,0),run_date:"2025-08-03T12:00:00Z"}],now);
assert.equal(stale.used,4,"La actividad antigua debe quedar fuera de la ventana de siete días");
const sprint=estimateSevenK(scenarios[9].runs,now);
assert.ok(sprint.conservative>40*60,"Un sprint aislado de 1 km no debe dominar el pronóstico");
console.log("VALIDACIONES: 10 personas x 4 corridas; sin BPM; sin desnivel; BPM bajos; sin RPE; recuperaciones; desnivel alto; dato antiguo; sprint atípico.");
