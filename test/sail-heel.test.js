import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { Hull } from '../src/hull.js';
const flat={sea:{dominantSpeed:10,dominantTravelRad:0},heightAt:()=>0,
 gradientAt:()=>({dx:0,dz:0}),orbitalVelocityAt:(x,z,out)=>out.set(0,0,0)};
for(const hz of [30,60,120])test(`steady loading heels the actual hull gradually and recovers (${hz}Hz)`,()=>{
 const hull=new Hull({headingDeg:0});
 hull.update(1/hz,flat,{heel:.2});
 assert.ok(hull.roll>0&&hull.roll<.01,'must not snap to the load angle');
 for(let i=1;i<30*hz;i++)hull.update(1/hz,flat,{heel:.2});
 assert.ok(Math.abs(hull.roll-.2)<1e-6);
 const starboard=new Vector3(4,0,0).applyQuaternion(hull.quaternion);
 const port=new Vector3(-4,0,0).applyQuaternion(hull.quaternion);
 assert.ok(starboard.y<-.79&&port.y>.79,'the leeward rail must actually lower');
 for(let i=0;i<30*hz;i++)hull.update(1/hz,flat,{heel:-.2});
 assert.ok(Math.abs(hull.roll+.2)<1e-6,'other tack must reverse the lean');
 for(let i=0;i<30*hz;i++)hull.update(1/hz,flat,{});
 assert.ok(Math.abs(hull.roll)<1e-6,'removed load must release the heel');
});
test('wave roll continues around the loaded equilibrium rather than being replaced',()=>{
 const field={...flat,heightAt:(x,z)=>-.05*x};
 const waveOnly=new Hull({headingDeg:0}),loaded=new Hull({headingDeg:0});
 for(let i=0;i<1800;i++){waveOnly.update(1/60,field);loaded.update(1/60,field,{heel:.15});}
 assert.ok(waveOnly.roll>.02);
 assert.ok(Math.abs(loaded.roll-waveOnly.roll-.15)<1e-6);
});
