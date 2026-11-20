import assert from "node:assert/strict";
import {estimateSevenK} from "../src/lib/estimate7k.js";
const now=new Date("2026-11-01T12:00:00-03:00").getTime();
const date=(daysAgo)=>new Date(now-daysAgo*86400000).toISOString();
const make=(km,paceMin,daysAgo=0,extra={})=>({
 distance_km:km,duration_seconds:Math.round(km*paceMin*60),difficulty:7,average_heartrate:160,
 total_elevation_gain:20,source:"manual",run_date:date(daysAgo),...extra
});

// Una carrera larga es la referencia principal; las sesiones cortas no pueden
// acelerar artificialmente una proyección de 7K.
const enduranceRunner=[
 make(10,6+23/60,0),
 make(5,6,1),
 make(5,5+40/60,2),
 make(2.4,5,3),
 make(3,5,4)
];
const endurance=estimateSevenK(enduranceRunner,now);
assert.ok(endurance,"10 km deben permitir una estimación");
assert.equal(endurance.bestCoverage,10);
assert.equal(endurance.used,1,"La carrera más larga debe dominar la referencia");
assert.ok(endurance.pace/60>6.05&&endurance.pace/60<6.3,"La predicción debe ser coherente con 10 km a 6:23");

// Con máximo de 4,5 km, las sesiones rápidas de 2,4–3 km no acreditan
// resistencia suficiente: no se debe mostrar una predicción numérica.
const shortRunner=[
 make(4.5,6),
 make(3,5),
 make(2.4,5.05),
 make(2.1,4.9)
];
assert.equal(estimateSevenK(shortRunner,now),null,"Máximo 4,5 km debe devolver datos insuficientes");

// Una referencia de 5 km sí permite una primera proyección, marcada como inicial.
const fiveK=estimateSevenK([make(5,6),make(3,5),make(2.4,4.9)],now);
assert.ok(fiveK);
assert.equal(fiveK.confidence,"Inicial");
assert.equal(fiveK.bestCoverage,5);

// Una carrera de 7 km o más aumenta la confianza.
const sevenK=estimateSevenK([make(7,6.2),make(4,6.0)],now);
assert.equal(sevenK.confidence,"Media");

// Los registros fuera de la ventana de siete días no deben servir como referencia.
const stale=estimateSevenK([make(10,6.3,20)],now);
assert.equal(stale,null);

console.log("OK: resistencia mínima 5K, carrera larga prioritaria, sesiones cortas excluidas de la proyección, confianza gradual y ventana móvil.");
