import test from 'node:test';
import assert from 'node:assert/strict';
import {createOcean} from '../src/render/ocean.js';
import {createSeaState} from '../src/spectrum.js';
import {WaveField} from '../src/wavefield.js';

test('render grid changes preserve the wave clock, samples, shader, uniforms and mesh',()=>{
 const field=new WaveField(createSeaState({preset:'storm',seed:1805}));
 const ocean=createOcean(field,{quality:{gridN:64,halfSpan:16000,exponent:2.2}});
 field.time=17;const h=field.heightAt(19,41),mesh=ocean.mesh,mat=mesh.material,uniforms=ocean.uniforms;
 let disposed=0;const initial=mesh.geometry;initial.addEventListener('dispose',()=>disposed++);
 assert.equal(ocean.setGridResolution(64),64);assert.equal(mesh.geometry,initial);
 for(const n of [352,256,168,128,352]){
  ocean.setGridResolution(n);assert.equal(ocean.gridResolution,n);assert.equal(mesh.geometry.attributes.position.count,n*n);
  assert.equal(ocean.mesh,mesh);assert.equal(mesh.material,mat);assert.equal(ocean.uniforms,uniforms);
  assert.equal(field.time,17);assert.equal(field.heightAt(19,41),h);
 }
 assert.equal(disposed,1);assert.throws(()=>ocean.setGridResolution(NaN),TypeError);
 assert.equal(ocean.setGridResolution(9000),512);assert.equal(ocean.setGridResolution(-1),32);
 ocean.dispose();
});
