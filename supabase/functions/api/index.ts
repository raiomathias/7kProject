import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEYS = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const KEY = SECRET_KEYS.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!KEY) throw new Error("Missing Supabase server secret key");
const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-bootstrap-secret", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Content-Type": "application/json" };
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
Deno.serve(async req => {
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  try {
    const url=new URL(req.url), path=url.pathname.split("/").filter(Boolean).pop() ?? "", method=req.method;
    const body=method==="GET"?{}:await req.json().catch(()=>({}));
    if(path==="bootstrap" && method==="POST") {
      const provided=req.headers.get("x-bootstrap-secret") ?? "";
      const expected=Deno.env.get("BOOTSTRAP_SECRET") ?? "";
      if(expected.length<32 || !same(provided,expected)) return json({error:"Código de configuración inválido."},403);
      const {count,error:countError}=await db.from("users").select("id",{count:"exact",head:true});
      if(countError) throw countError;
      if((count??0)>0) return json({error:"La configuración inicial ya fue completada."},409);
      const members=[{username:"mathias",display_name:"Mathias",role:"admin"},{username:"lukas",display_name:"Lukas",role:"member"},{username:"vicente",display_name:"Vicente",role:"member"}];
      if(!Array.isArray(body.accounts)||body.accounts.length!==3) return json({error:"Debes definir las tres contraseñas iniciales."},400);
      const rows=[];
      for(const member of members) {
        const account=body.accounts.find((x:any)=>String(x.username).toLowerCase()===member.username);
        if(!account || typeof account.password!=="string" || account.password.length<10) return json({error:"Cada contraseña debe tener al menos 10 caracteres."},400);
        const salt=random(16);
        rows.push({...member,password_salt:salt,password_hash:await passwordHash(account.password,salt)});
      }
      const {error}=await db.from("users").insert(rows);
      if(error) throw error;
      const {data:settings}=await db.from("goal_settings").select("*").eq("id",true).single();
      return json({success:true,message:"Cuentas creadas. Ya pueden iniciar sesión.",settings});
    }
    if(path==="login" && method==="POST") {
      const username=String(body.username??"").trim().toLowerCase(), password=String(body.password??"");
      if(!username||!password||password.length>256) return json({error:"Usuario o contraseña incorrectos."},401);
      const {data:u}=await db.from("users").select("*").eq("username",username).eq("is_active",true).maybeSingle();
      const calculated=u?await passwordHash(password,u.password_salt):await passwordHash(password,"00112233445566778899aabbccddeeff");
      if(!u || !same(calculated,u.password_hash)) return json({error:"Usuario o contraseña incorrectos."},401);
      const token=random(32), tokenHash=await sha(token);
      const {error}=await db.from("sessions").insert({user_id:u.id,token_hash:tokenHash,expires_at:new Date(Date.now()+30*86400000).toISOString(),user_agent:req.headers.get("user-agent")?.slice(0,300)});
      if(error) throw error;
      return json({token,user:cleanUser(u)});
    }
    const auth=await session(req);
    if(!auth) return json({error:"Sesión inválida o expirada. Inicia sesión nuevamente."},401);
    const me=auth.user, admin=me.role==="admin";
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
      const paths=[...(users??[]).map((u:any)=>u.avatar_path),...(runs??[]).flatMap((r:any)=>[r.strava_image_path,r.extra_image_path])].filter(Boolean);
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