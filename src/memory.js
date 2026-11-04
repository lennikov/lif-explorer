/* @repository-note
   memory.js: Select memory and 3D preview budgets for browser environments.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

(function(root){
 'use strict';const MiB=1024*1024;
 function profile(platform='',choice='auto'){
  const low=choice==='low'||(choice==='auto'&&/mac|iphone|ipad/i.test(platform));
  return low?{name:'Low memory',low:true,workingBytes:192*MiB,cacheBytes:8*MiB,volumeBytes:8*MiB,volumeDimension:128,backbufferPixels:1000000,maxExportBytes:192*MiB}:{name:'Standard',low:false,workingBytes:512*MiB,cacheBytes:48*MiB,volumeBytes:48*MiB,volumeDimension:256,backbufferPixels:1920000,maxExportBytes:512*MiB};
 }
 function layout(s,p){const pixels=s.width*s.height,C=s.channels.length,native=pixels*s.channels.reduce((n,c)=>n+(c.bitDepth<=8?1:2),0);if(!Number.isSafeInteger(pixels)||pixels<1||pixels>32*1024*1024||C<1||C>32)throw Error('This series exceeds the workspace dimensions (32 megapixels per plane, 32 channels).');return {pixels,nativeBytes:native,rgbaBytes:pixels*4,slicePeakBytes:native+pixels*8+Math.min(p.cacheBytes,native)+4*MiB};}
 function guard(s,p,kind='slice',extra=0){const l=layout(s,p);const bytes=l.slicePeakBytes+(kind==='mip'?l.nativeBytes:0)+extra;if(bytes>p.workingBytes)throw Error(`${kind==='mip'?'This projection':'This image view'} needs about ${Math.ceil(bytes/MiB)} MB of working memory, above the ${Math.round(p.workingBytes/MiB)} MB ${p.name.toLowerCase()} budget. Choose a smaller series, or select Standard memory mode when memory permits. Metadata remains available.`);return bytes;}
 function volume(s,p,maxDimension=256){let scale=Math.min(1,Math.min(p.volumeDimension,maxDimension)/Math.max(s.width,s.height,s.depth));const bytesPerVoxel=s.channels.reduce((n,c)=>n+(c.bitDepth<=8?1:2),0);scale=Math.min(scale,Math.cbrt(p.volumeBytes/(s.width*s.height*s.depth*bytesPerVoxel)));const size=()=>({width:Math.max(1,Math.floor(s.width*scale)),height:Math.max(1,Math.floor(s.height*scale)),depth:Math.max(1,Math.floor(s.depth*scale))});let v=size();while(v.width*v.height*v.depth*bytesPerVoxel>p.volumeBytes){scale*=.95;v=size();}return {...v,nativeBytes:v.width*v.height*v.depth*bytesPerVoxel,rgbaBytes:v.width*v.height*v.depth*4};}
 const api={profile,layout,guard,volume,MiB};root.LifMemory=api;if(typeof module!=='undefined')module.exports=api;
})(typeof self!=='undefined'?self:globalThis);

