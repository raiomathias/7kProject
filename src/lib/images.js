export async function compressImage(file,kind="run") {
 if(!file||!file.type.startsWith("image/")) throw new Error("Selecciona una imagen válida.");
 if(file.size>18*1024*1024) throw new Error("La imagen original no puede superar 18 MB.");
 const bitmap=await createImageBitmap(file), max=kind==="avatar"?640:1920, scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
 const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
 const ctx=canvas.getContext("2d",{alpha:false}); ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("No se pudo comprimir la imagen.")),"image/webp",kind==="avatar"?.82:.78));
 if(blob.size>5*1024*1024) throw new Error("La imagen sigue siendo demasiado grande después de comprimirla."); return new File([blob],`${Date.now()}.webp`,{type:"image/webp"});
}
export const formatBytes=n=>n<1048576?`${(n/1024).toFixed(0)} KB`:`${(n/1048576).toFixed(1)} MB`;