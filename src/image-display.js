/* @repository-note
   image-display.js: Build channel color look-up tables independent of source pixels.
   This note is stripped when building the canonical v2.1 release.
   Module order matters: the runtime uses browser globals.
*/

(function(root){
  'use strict';
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  function hex(color){return [1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);}
  function lut(channel,max=65535){
    const out=new Uint8Array((max+1)*3),rgb=hex(channel.color),span=Math.max(1,channel.max-channel.min),gamma=1/Math.max(.05,channel.gamma||1);
    if(!channel.enabled)return out;
    for(let i=0;i<=max;i++){const v=Math.pow(clamp((i-channel.min)/span,0,1),gamma)*255;for(let c=0;c<3;c++)out[i*3+c]=Math.round(v*rgb[c]);}
    return out;
  }
  function composite(planes,channels,width,height){
    const out=new Uint8ClampedArray(width*height*4),tables=channels.map(c=>lut(c));
    for(let i=0;i<width*height;i++) {let r=0,g=0,b=0;for(let c=0;c<planes.length;c++){if(!channels[c].enabled)continue;const k=planes[c][i]*3,t=tables[c];r+=t[k];g+=t[k+1];b+=t[k+2];}const j=i*4;out[j]=Math.min(255,r);out[j+1]=Math.min(255,g);out[j+2]=Math.min(255,b);out[j+3]=255;}
    return out;
  }
  function volumeRGB(volumes,channels){
    const length=volumes[0].length,out=new Uint8Array(length*3),tables=channels.map(c=>lut(c));
    for(let i=0;i<length;i++){let r=0,g=0,b=0;for(let c=0;c<volumes.length;c++){if(!channels[c].enabled)continue;const k=volumes[c][i]*3,t=tables[c];r+=t[k];g+=t[k+1];b+=t[k+2];}out[i*3]=Math.min(255,r);out[i*3+1]=Math.min(255,g);out[i*3+2]=Math.min(255,b);}
    return out;
  }
  function volumeRGBA(volumes,channels){
    const length=volumes[0].length,out=new Uint8Array(length*4),tables=channels.map(c=>lut(c));
    for(let i=0;i<length;i++){let r=0,g=0,b=0;for(let c=0;c<volumes.length;c++){if(!channels[c].enabled)continue;const k=volumes[c][i]*3,t=tables[c];r+=t[k];g+=t[k+1];b+=t[k+2];}const k=i*4;out[k]=Math.min(255,r);out[k+1]=Math.min(255,g);out[k+2]=Math.min(255,b);out[k+3]=255;}return out;
  }
  function sampleSize(width,height,depth,channels,maxDimension=256){
    let scale=Math.min(1,maxDimension/width,maxDimension/height,maxDimension/depth);
    scale=Math.min(scale,Math.cbrt(48*1024*1024/(2*width*height*depth*channels)));
    return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale)),depth:Math.max(1,Math.round(depth*scale))};
  }
  function accumulate(plane,width,height,z,mip,xz,yz,hist,maxValue=65535){
    let min=65535,max=0;for(let y=0;y<height;y++){let rowMax=0;for(let x=0;x<width;x++){const i=y*width+x,v=plane[i];if(v>mip[i])mip[i]=v;if(v>xz[z*width+x])xz[z*width+x]=v;if(v>rowMax)rowMax=v;if(v<min)min=v;if(v>max)max=v;if(hist)hist[Math.min(255,Math.floor(v*256/(maxValue+1)))]++;}yz[z*height+y]=rowMax;}return {min,max};
  }
  const api={clamp,hex,lut,composite,volumeRGB,volumeRGBA,sampleSize,accumulate};root.LifImaging=api;if(typeof module!=='undefined')module.exports=api;
})(typeof self!=='undefined'?self:globalThis);

