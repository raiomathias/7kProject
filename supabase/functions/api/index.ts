import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!KEY) throw new Error("Missing Supabase server secret key");
const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Content-Type": "application/json" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const sha = async (v: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))).map(x=>x.toString(16).padStart(2,"0")).join("");
const random = (n=32) => { const b=crypto.getRandomValues(new Uint8Array(n)); return Array.from(b,x=>x.toString(16).padStart(2,"0")).join(""); };
const passwordHash = async (password: string, salt: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt:Uint8Array.from(salt.match(/.{2}/g)!.map(x=>parseInt(x,16))), iterations:310000, hash:"SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits),x=>x.toString(16).padStart(2,"0")).join("");
};
const same = (a:string,b:string) => a.length===b.length && a.split("").reduce((v,c,i)=>v|(c.charCodeAt(0)^b.charCodeAt(i)),0)===0;
const cleanUser = (u:any) => ({ id:u.id, username:u.username, display_name:u.display_name, role:u.role, avatar_path:u.avatar_path, bio:u.bio });
async function session(req:Request) {
  const token=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"") ?? "";
  if(!token) return null;
  const {data:s}=await db.from("sessions").select("id,user_id,expires_at").eq("token_hash",await sha(token)).is("revoked_at",null).gt("expires_at",new Date().toISOString()).maybeSingle();
  if(!s) return null;
  const {data:u}=await db.from("users").select("*").eq("id",s.user_id).eq("is_active",true).maybeSingle();
  return u ? {session:s,user:u} : null;
}
async function logEvent(userId:string,type:string,message:string,runId:string|null=null) {
  await db.from("activity_events").insert({user_id:userId,event_type:type,message,run_id:runId});
}

const STRAVA_CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID") ?? "292853";
const STRAVA_CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
const STRAVA_ENCRYPTION_KEY = Deno.env.get("STRAVA_TOKEN_ENCRYPTION_KEY") ?? "";
const STRAVA_VERIFY_TOKEN = Deno.env.get("STRAVA_WEBHOOK_VERIFY_TOKEN") ?? "";
const STRAVA_REDIRECT_URI = URL + "/functions/v1/api/strava-callback";
const APP_RETURN_URL = "https://raiomathias.github.io/7kProject/panel/?strava=connected";
const b64 = (bytes:Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value:string) => Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function encryptionKey() {
  if(!STRAVA_ENCRYPTION_KEY) throw new Error("Falta configurar STRAVA_TOKEN_ENCRYPTION_KEY.");
  const raw=unb64(STRAVA_ENCRYPTION_KEY);
  if(raw.length!==32) throw new Error("STRAVA_TOKEN_ENCRYPTION_KEY debe ser una clave Base64 de 32 bytes.");
  return crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptToken(value:string) {
  const nonce=crypto.getRandomValues(new Uint8Array(12)), key=await encryptionKey();
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce},key,new TextEncoder().encode(value));
  return {cipher:b64(new Uint8Array(cipher)),nonce:b64(nonce)};
}
async function decryptToken(cipher:string,nonce:string) {
  const key=await encryptionKey();
  const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(nonce)},key,unb64(cipher));
  return new TextDecoder().decode(clear);
}
async function stravaRefresh(connection:any) {
  if(Number(connection.expires_at)>Math.floor(Date.now()/1000)+300) return await decryptToken(connection.access_token_cipher,connection.access_token_nonce);
  if(!STRAVA_CLIENT_SECRET) throw new Error("Falta configurar STRAVA_CLIENT_SECRET.");
  const refresh=await decryptToken(connection.refresh_token_cipher,connection.refresh_token_nonce);
  const response=await fetch("https://www.strava.com/oauth/token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_id:STRAVA_CLIENT_ID,client_secret:STRAVA_CLIENT_SECRET,grant_type:"refresh_token",refresh_token:refresh})});
  const data=await response.json();
  if(!response.ok) throw new Error(data.message||"No se pudo renovar el acceso a Strava.");
  const access=await encryptToken(data.access_token), nextRefresh=await encryptToken(data.refresh_token);
  await db.from("strava_connections").update({access_token_cipher:access.cipher,access_token_nonce:access.nonce,refresh_token_cipher:nextRefresh.cipher,refresh_token_nonce:nextRefresh.nonce,expires_at:data.expires_at,updated_at:new Date().toISOString(),last_sync_error:null}).eq("user_id",connection.user_id);
  return data.access_token as string;
}
async function stravaRequest(token:string,path:string) {
  const response=await fetch("https://www.strava.com/api/v3"+path,{headers:{Authorization:"Bearer "+token}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.message||"Strava API respondió "+response.status);
  return data;
}
async function saveStravaActivity(userId:string,token:string,summary:any,includeStreams=false) {
  const detail=includeStreams?await stravaRequest(token,"/activities/"+summary.id):summary;
  const kind=String(detail.sport_type||detail.type||summary.sport_type||summary.type||"");
  if(!["Run","TrailRun","VirtualRun"].includes(kind)) return null;
  const distance=Number(detail.distance||summary.distance)/1000;
  const duration=Math.max(1,Math.round(Number(detail.moving_time||summary.moving_time)));
  if(!Number.isFinite(distance)||distance<=0||distance>100||duration>86400) return null;
  const row={
    user_id:userId,run_date:detail.start_date||summary.start_date,distance_km:Number(distance.toFixed(2)),
    duration_seconds:duration,difficulty:7,notes:"Importada desde Strava · "+String(detail.name||summary.name||"Corrida").slice(0,100),
    source:"strava",strava_activity_id:Number(summary.id),average_heartrate:detail.average_heartrate??null,
    max_heartrate:detail.max_heartrate??null,average_cadence:detail.average_cadence??null,
    total_elevation_gain:detail.total_elevation_gain??null,average_speed:detail.average_speed??null,
    max_speed:detail.max_speed??null,calories:detail.calories??null,
    summary_polyline:detail.map?.summary_polyline??summary.map?.summary_polyline??null,
    start_latitude:detail.start_latlng?.[0]??null,start_longitude:detail.start_latlng?.[1]??null,
    strava_activity_url:"https://www.strava.com/activities/"+summary.id,elapsed_seconds:Number(detail.elapsed_time||summary.elapsed_time||duration),
    strava_splits:detail.splits_metric??[]
  };
  const {data:run,error}=await db.from("runs").upsert(row,{onConflict:"strava_activity_id"}).select("id").single();
  if(error) throw error;
  let streams:any={};
  if(includeStreams) {
    try { streams=await stravaRequest(token,"/activities/"+summary.id+"/streams?keys=time,distance,latlng,altitude,heartrate,cadence,velocity_smooth,grade_smooth&key_by_type=true"); } catch(e) { console.warn("Strava streams unavailable",e); }
  }
  const {error:detailError}=await db.from("strava_activity_details").upsert({
    strava_activity_id:Number(summary.id),user_id:userId,run_id:run.id,activity_type:kind,
    timezone:detail.timezone??null,start_date_local:detail.start_date_local??null,
    moving_time:detail.moving_time??duration,elapsed_time:detail.elapsed_time??duration,
    streams,splits_metric:detail.splits_metric??[],laps:detail.laps??[],raw_summary:{
      name:detail.name??summary.name??null,description:detail.description??null,device_name:detail.device_name??null,
      gear_name:detail.gear?.name??null,pr_count:detail.pr_count??null,achievement_count:detail.achievement_count??null
    },updated_at:new Date().toISOString()
  },{onConflict:"strava_activity_id"});
  if(detailError) throw detailError;
  return run.id;
}
async function syncStravaUser(userId:string) {
  const {data:connection,error}=await db.from("strava_connections").select("*").eq("user_id",userId).eq("connected",true).maybeSingle();
  if(error||!connection) throw new Error("No hay una cuenta Strava conectada.");
  try {
    const token=await stravaRefresh(connection);
    const activities:any[]=[];
    for(let page=1;page<=20;page++) {
      const batch=await stravaRequest(token,"/athlete/activities?per_page=100&page="+page);
      activities.push(...(batch||[]));
      if(!batch||batch.length<100) break;
    }
    const running=activities.filter((a:any)=>["Run","TrailRun","VirtualRun"].includes(String(a.sport_type||a.type)));
    let imported=0,details=0;
    for(const activity of running) {
      await saveStravaActivity(userId,token,activity,details<12);
      imported++; if(details<12) details++;
    }
    await db.from("strava_connections").update({last_sync_at:new Date().toISOString(),last_sync_error:null,updated_at:new Date().toISOString()}).eq("user_id",userId);
    await logEvent(userId,"strava_sync", "Sincronizó "+imported+" corridas desde Strava");
    return {imported,checked:activities.length,detailed:details};
  } catch(error) {
    await db.from("strava_connections").update({last_sync_error:String((error as Error)?.message||"Error de sincronización").slice(0,400)}).eq("user_id",userId);
    throw error;
  }
}

async function ensureStravaWebhook() {
  if(!STRAVA_CLIENT_SECRET||!STRAVA_VERIFY_TOKEN) throw new Error("Faltan STRAVA_CLIENT_SECRET o STRAVA_WEBHOOK_VERIFY_TOKEN en Supabase.");
  const base="https://www.strava.com/api/v3/push_subscriptions";
  const params=new URLSearchParams({client_id:STRAVA_CLIENT_ID,client_secret:STRAVA_CLIENT_SECRET});
  const check=await fetch(base+"?"+params.toString());
  if(check.ok) {
    const existing=await check.json();
    if(Array.isArray(existing)&&existing.some((x:any)=>x.callback_url==="https://"+new URL(URL).host+"/functions/v1/api/strava-webhook")) return;
  }
  const response=await fetch(base,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({
    client_id:STRAVA_CLIENT_ID,client_secret:STRAVA_CLIENT_SECRET,
    callback_url:"https://"+new URL(URL).host+"/functions/v1/api/strava-webhook",
    verify_token:STRAVA_VERIFY_TOKEN
  })});
  if(!response.ok) {
    const detail=await response.text();
    if(response.status===409) return;
    throw new Error("No se pudo registrar el webhook de Strava: "+detail.slice(0,220));
  }
}
async function processStravaWebhook(payload:any) {
  if(payload.object_type!=="activity") return;
  const {data:connection}=await db.from("strava_connections").select("*").eq("athlete_id",Number(payload.owner_id)).eq("connected",true).maybeSingle();
  if(!connection) return;
  const activityId=Number(payload.object_id);
  if(payload.aspect_type==="delete") {
    const {data:run}=await db.from("runs").select("id").eq("strava_activity_id",activityId).maybeSingle();
    if(run) await db.from("runs").delete().eq("id",run.id);
    return;
  }
  const token=await stravaRefresh(connection);
  await saveStravaActivity(connection.user_id,token,{id:activityId},true);
  await db.from("strava_connections").update({updated_at:new Date().toISOString()}).eq("user_id",connection.user_id);
}
Deno.serve(async req => {
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  try {
    const url=new URL(req.url), path=url.pathname.split("/").filter(Boolean).pop() ?? "", method=req.method;
    const body=method==="GET"?{}:await req.json().catch(()=>({}));

    if(path==="strava-webhook" && method==="GET") {
      const mode=url.searchParams.get("hub.mode"),verify=url.searchParams.get("hub.verify_token"),challenge=url.searchParams.get("hub.challenge");
      if(mode==="subscribe" && STRAVA_VERIFY_TOKEN && verify===STRAVA_VERIFY_TOKEN) return json({"hub.challenge":challenge});
      return json({error:"Verificación de webhook no válida."},403);
    }
    if(path==="strava-webhook" && method==="POST") {
      const payload=body;
      if(!payload.object_type||!payload.object_id||!payload.aspect_type||!payload.owner_id) return json({error:"Evento inválido."},400);
      const {data:event,error}=await db.from("strava_webhook_events").insert({
        object_type:payload.object_type,object_id:payload.object_id,aspect_type:payload.aspect_type,
        owner_id:payload.owner_id,updates:payload.updates||{},event_time:payload.event_time||null,payload
      }).select("id").single();
      if(error) throw error;
      const work=processStravaWebhook(payload).then(async()=>{await db.from("strava_webhook_events").update({processed_at:new Date().toISOString()}).eq("id",event.id)}).catch(async(e)=>{await db.from("strava_webhook_events").update({error:String(e?.message||e).slice(0,400)}).eq("id",event.id)});
      (globalThis as any).EdgeRuntime?.waitUntil?.(work);
      return json({received:true});
    }
    if(path==="strava-callback" && method==="GET") {
      const code=url.searchParams.get("code")||"",state=url.searchParams.get("state")||"",error=url.searchParams.get("error");
      if(error||!code||!state||!STRAVA_CLIENT_SECRET) return Response.redirect("https://raiomathias.github.io/7kProject/panel/?strava=error",302);
      const {data:oauth}=await db.from("strava_oauth_states").select("user_id,expires_at").eq("state_hash",await sha(state)).gt("expires_at",new Date().toISOString()).maybeSingle();
      if(!oauth) return Response.redirect("https://raiomathias.github.io/7kProject/panel/?strava=state_error",302);
      await db.from("strava_oauth_states").delete().eq("state_hash",await sha(state));
      const response=await fetch("https://www.strava.com/oauth/token",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_id:STRAVA_CLIENT_ID,client_secret:STRAVA_CLIENT_SECRET,code,grant_type:"authorization_code"})});
      const data=await response.json();
      if(!response.ok||!data.athlete?.id) return Response.redirect("https://raiomathias.github.io/7kProject/panel/?strava=exchange_error",302);
      const {data:existing}=await db.from("strava_connections").select("user_id").eq("athlete_id",Number(data.athlete.id)).maybeSingle();
      if(existing&&existing.user_id!==oauth.user_id) return Response.redirect("https://raiomathias.github.io/7kProject/panel/?strava=already_linked",302);
      const access=await encryptToken(data.access_token),refresh=await encryptToken(data.refresh_token);
      const {error:saveError}=await db.from("strava_connections").upsert({
        user_id:oauth.user_id,athlete_id:Number(data.athlete.id),athlete_username:data.athlete.username??null,
        athlete_firstname:data.athlete.firstname??null,athlete_lastname:data.athlete.lastname??null,
        athlete_profile:data.athlete.profile??data.athlete.profile_medium??null,
        access_token_cipher:access.cipher,access_token_nonce:access.nonce,
        refresh_token_cipher:refresh.cipher,refresh_token_nonce:refresh.nonce,
        expires_at:data.expires_at,scopes:String(url.searchParams.get("scope")||"activity:read_all"),
        connected:true,last_sync_error:null,updated_at:new Date().toISOString()
      },{onConflict:"user_id"});
      if(saveError) throw saveError;
      return Response.redirect(APP_RETURN_URL,302);
    }
    if(path==="login" && method==="POST") {
      const username=String(body.username??"").trim().toLowerCase(), password=String(body.password??"");
      if(!username||!password||password.length>256) return json({error:"Usuario o contraseña incorrectos."},401);
      const ip=req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const ipHash=await sha(ip), cutoff=new Date(Date.now()-15*60*1000).toISOString();
      const {count:attempts}=await db.from("login_attempts").select("id",{count:"exact",head:true}).eq("username",username).eq("ip_hash",ipHash).gt("attempted_at",cutoff);
      if((attempts??0)>=8) return json({error:"Demasiados intentos. Espera 15 minutos antes de volver a intentar."},429);
      await db.from("login_attempts").delete().lt("attempted_at",new Date(Date.now()-24*60*60*1000).toISOString());
      const {data:u}=await db.from("users").select("*").eq("username",username).eq("is_active",true).maybeSingle();
      const calculated=u?await passwordHash(password,u.password_salt):await passwordHash(password,"00112233445566778899aabbccddeeff");
      if(!u || !same(calculated,u.password_hash)) {
        await db.from("login_attempts").insert({username,ip_hash:ipHash});
        return json({error:"Usuario o contraseña incorrectos."},401);
      }
      await db.from("login_attempts").delete().eq("username",username).eq("ip_hash",ipHash);
      const token=random(32), tokenHash=await sha(token);
      const {error}=await db.from("sessions").insert({user_id:u.id,token_hash:tokenHash,expires_at:new Date(Date.now()+30*86400000).toISOString(),user_agent:req.headers.get("user-agent")?.slice(0,300)});
      if(error) throw error;
      return json({token,user:cleanUser(u)});
    }

    if(path==="public-dashboard" && method==="GET") {
      const [{data:users,error:e1},{data:runs,error:e2},{data:settings,error:e3},{data:events,error:e4}] = await Promise.all([
        db.from("users").select("id,display_name,avatar_path").eq("is_active",true).order("display_name"),
        db.from("runs").select("id,user_id,run_date,distance_km,duration_seconds,pace_seconds_per_km,difficulty,source").order("run_date",{ascending:false}).limit(1000),
        db.from("goal_settings").select("target_distance_km,deadline,banner_message").eq("id",true).single(),
        db.from("activity_events").select("id,message,created_at").order("created_at",{ascending:false}).limit(20)
      ]);
      if(e1||e2||e3||e4) throw e1??e2??e3??e4;
      const media:Record<string,string>={};
      const paths=[...(users??[]).map((u:any)=>u.avatar_path)].filter(Boolean);
      await Promise.all([...new Set(paths)].map(async(objectPath:string)=>{
        const {data:signed}=await db.storage.from("7k-media").createSignedUrl(objectPath,3600);
        if(signed?.signedUrl) media[objectPath]=signed.signedUrl;
      }));
      const publicUsers=(users??[]).map((u:any)=>({...u,avatar_url:u.avatar_path?media[u.avatar_path]??null:null}));
      return json({users:publicUsers,runs:runs??[],settings,events:events??[]});
    }
    const auth=await session(req);
    if(!auth) return json({error:"Sesión inválida o expirada. Inicia sesión nuevamente."},401);
    const me=auth.user, admin=me.role==="admin";

    if(path==="strava-connect" && method==="POST") {
      if(!STRAVA_CLIENT_SECRET||!STRAVA_ENCRYPTION_KEY||!STRAVA_VERIFY_TOKEN) return json({error:"La integración todavía requiere configurar STRAVA_CLIENT_SECRET, STRAVA_TOKEN_ENCRYPTION_KEY y STRAVA_WEBHOOK_VERIFY_TOKEN en Supabase."},503);
      await ensureStravaWebhook();
      const state=random(24),stateHash=await sha(state);
      await db.from("strava_oauth_states").delete().lt("expires_at",new Date().toISOString());
      const {error}=await db.from("strava_oauth_states").insert({state_hash:stateHash,user_id:me.id,expires_at:new Date(Date.now()+10*60*1000).toISOString()});
      if(error) throw error;
      const authorize=new URL("https://www.strava.com/oauth/authorize");
      authorize.searchParams.set("client_id",STRAVA_CLIENT_ID);
      authorize.searchParams.set("redirect_uri",STRAVA_REDIRECT_URI);
      authorize.searchParams.set("response_type","code");
      authorize.searchParams.set("approval_prompt","auto");
      authorize.searchParams.set("scope","read,activity:read_all");
      authorize.searchParams.set("state",state);
      return json({authorize_url:authorize.toString()});
    }
    if(path==="strava-status" && method==="GET") {
      const {data:connection,error}=await db.from("strava_connections").select("athlete_id,athlete_username,athlete_firstname,athlete_lastname,athlete_profile,scopes,last_sync_at,last_sync_error,connected").eq("user_id",me.id).maybeSingle();
      if(error) throw error;
      return json({connected:!!connection?.connected,connection:connection||null});
    }
    if(path==="strava-sync" && method==="POST") {
      const result=await syncStravaUser(me.id);
      return json({success:true,...result});
    }
    if(path==="strava-disconnect" && method==="POST") {
      const {data:connection}=await db.from("strava_connections").select("*").eq("user_id",me.id).maybeSingle();
      if(connection) {
        try {
          const token=await stravaRefresh(connection);
          await fetch("https://www.strava.com/oauth/deauthorize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({access_token:token})});
        } catch(e) { console.warn("Strava deauthorization request failed",e); }
        await db.from("strava_connections").delete().eq("user_id",me.id);
      }
      return json({success:true});
    }

    if(path==="logout" && method==="POST") {
      await db.from("sessions").update({revoked_at:new Date().toISOString()}).eq("id",auth.session.id);
      return json({success:true});
    }
    if(path==="me" && method==="GET") return json({user:cleanUser(me)});
    if(path==="dashboard" && method==="GET") {
      const [{data:users,error:e1},{data:runs,error:e2},{data:settings,error:e3},{data:events,error:e4}] = await Promise.all([
        db.from("users").select("id,username,display_name,role,avatar_path,bio").eq("is_active",true).order("display_name"),
        db.from("runs").select("*").order("run_date",{ascending:false}).limit(300),
        db.from("goal_settings").select("*").eq("id",true).single(),
        db.from("activity_events").select("id,user_id,event_type,run_id,message,created_at").order("created_at",{ascending:false}).limit(20)
      ]);
      if(e1||e2||e3||e4) throw e1??e2??e3??e4;
      const paths=[...(users??[]).map((u:any)=>u.avatar_path),...(runs??[]).slice(0,12).flatMap((r:any)=>[r.strava_image_path,r.extra_image_path])].filter(Boolean);
      const media:Record<string,string>={};
      await Promise.all([...new Set(paths)].map(async(path:string)=>{const {data:signed}=await db.storage.from("7k-media").createSignedUrl(path,3600);if(signed?.signedUrl)media[path]=signed.signedUrl;}));
      return json({users,runs,settings,events,media});
    }
    if(path==="runs" && method==="POST") {
      const distance=Number(body.distance_km), duration=Number(body.duration_seconds), difficulty=Number(body.difficulty);
      if(!Number.isFinite(distance)||distance<=0||distance>100||!Number.isInteger(duration)||duration<=0||duration>86400||!Number.isInteger(difficulty)||difficulty<1||difficulty>10) return json({error:"Revisa distancia, tiempo y dificultad."},400);
      const row={user_id:me.id,distance_km:distance,duration_seconds:duration,difficulty,notes:String(body.notes??"").slice(0,1200),strava_image_path:body.strava_image_path||null,extra_image_path:body.extra_image_path||null,run_date:body.run_date||new Date().toISOString()};
      const {data,error}=await db.from("runs").insert(row).select("*").single();
      if(error) throw error;
      await logEvent(me.id,"run_created",me.display_name+" registró "+distance.toFixed(2)+" km",data.id);
      return json({run:data},201);
    }
    if(path==="runs" && method==="DELETE") {
      const id=String(url.searchParams.get("id")??"");
      const {data:r}=await db.from("runs").select("id,user_id,distance_km").eq("id",id).maybeSingle();
      if(!r) return json({error:"Entrenamiento no encontrado."},404);
      if(r.user_id!==me.id&&!admin) return json({error:"No tienes permiso para eliminar este entrenamiento."},403);
      const {error}=await db.from("runs").delete().eq("id",id);
      if(error) throw error;
      return json({success:true});
    }
    if(path==="goal" && method==="PATCH") {
      if(!admin) return json({error:"Solo Mathias puede modificar el objetivo del equipo."},403);
      const distance=Number(body.target_distance_km);
      if(!Number.isFinite(distance)||distance<1||distance>100) return json({error:"Objetivo no válido."},400);
      const {data,error}=await db.from("goal_settings").update({target_distance_km:distance,deadline:body.deadline||null,banner_message:String(body.banner_message??"").slice(0,240),updated_by:me.id,updated_at:new Date().toISOString()}).eq("id",true).select("*").single();
      if(error) throw error;
      return json({settings:data});
    }
    if(path==="profile" && method==="PATCH") {
      const bio=String(body.bio??"").slice(0,280), avatar=body.avatar_path?String(body.avatar_path):null;
      const {data,error}=await db.from("users").update({bio,avatar_path:avatar,updated_at:new Date().toISOString()}).eq("id",me.id).select("id,username,display_name,role,avatar_path,bio").single();
      if(error) throw error;
      return json({user:data});
    }
    if(path==="admin-users" && method==="PATCH") {
      if(!admin) return json({error:"Acceso exclusivo de administración."},403);
      const id=String(body.id??""), password=String(body.password??"");
      const updates:any={display_name:String(body.display_name??"").slice(0,80),bio:String(body.bio??"").slice(0,280),avatar_path:body.avatar_path||null};
      if(password) {
        if(password.length<10) return json({error:"La contraseña debe tener al menos 10 caracteres."},400);
        const salt=random(16); updates.password_salt=salt; updates.password_hash=await passwordHash(password,salt);
      }
      if(body.is_active!==undefined) updates.is_active=Boolean(body.is_active);
      const {data,error}=await db.from("users").update(updates).eq("id",id).select("id,username,display_name,role,avatar_path,bio,is_active").single();
      if(error) throw error;
      if(body.is_active===false) await db.from("sessions").update({revoked_at:new Date().toISOString()}).eq("user_id",id).is("revoked_at",null);
      return json({user:data});
    }
    if(path==="media" && method==="POST") {
      const paths=Array.isArray(body.paths)?body.paths.slice(0,4):[];
      const media:Record<string,string>={};
      for(const objectPath of paths) {
        if(typeof objectPath!=="string" || !objectPath.startsWith("runs/") || !objectPath.endsWith(".webp")) continue;
        const {data:signed,error}=await db.storage.from("7k-media").createSignedUrl(objectPath,3600);
        if(!error && signed?.signedUrl) media[objectPath]=signed.signedUrl;
      }
      return json({media});
    }
    if(path==="upload" && method==="POST") {
      const bucket=db.storage.from("7k-media");
      const folder=String(body.folder??"runs");
      if(!["runs","avatars"].includes(folder)) return json({error:"Carpeta no válida."},400);
      const fileName=String(body.file_name??"").replace(/[^a-zA-Z0-9._-]/g,"").slice(0,100);
      if(!fileName.endsWith(".webp")) return json({error:"Solo se aceptan imágenes WebP comprimidas."},400);
      const targetUserId=String(body.user_id??me.id);
      if(targetUserId!==me.id&&!admin) return json({error:"Solo administración puede gestionar fotos de otros integrantes."},403);
      const {data:targetUser}=await db.from("users").select("id").eq("id",targetUserId).eq("is_active",true).maybeSingle();
      if(!targetUser) return json({error:"Integrante no encontrado."},404);
      const objectPath=folder+"/"+targetUserId+"/"+crypto.randomUUID()+".webp";
      const {data,error}=await bucket.createSignedUploadUrl(objectPath,{upsert:false});
      if(error) throw error;
      return json({path:objectPath,token:data.token,signedUrl:data.signedUrl});
    }
    return json({error:"Ruta no encontrada."},404);
  } catch(error) {
    console.error("7k api error",error);
    return json({error:"Ocurrió un error interno. Intenta nuevamente."},500);
  }
});