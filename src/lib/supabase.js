import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL || "https://vbexpblajrvuciuxlytu.supabase.co";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "missing-key";
export const supabase = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const API = `${url}/functions/v1/api`;
export async function api(path,{method="GET",token,body,headers={}}={}) {
 const response=await fetch(`${API}/${path}`,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json().catch(()=>({})); if(!response.ok) throw new Error(data.error||"No se pudo completar la solicitud."); return data;
}