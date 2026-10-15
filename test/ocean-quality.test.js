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

test('the near field can be switched off and on under a running sea, and is then the shader it would have been built as',()=>{
 const field=new WaveField(createSeaState({preset:'storm',seed:1805}));
 const fakeCascade={uniforms:{}};
 const build=normalRange=>createOcean(field,{quality:{gridN:64,halfSpan:16000,exponent:2.2,normalRange},cascade:fakeCascade});
 const near=build(400),far=build(0),ocean=build(400);
 assert.equal(ocean.normalRange,400);assert.ok('uCascade' in ocean.uniforms);
 field.time=23;const h=field.heightAt(-7,12),mesh=ocean.mesh,first=mesh.material;
 assert.equal(ocean.setNormalRange(0),0);
 assert.notEqual(mesh.material,first);assert.equal(ocean.mesh,mesh);assert.equal(ocean.normalRange,0);
 assert.equal(mesh.material.fragmentShader,far.mesh.material.fragmentShader);
 assert.equal(mesh.material.vertexShader,far.mesh.material.vertexShader);
 assert.deepEqual(Object.keys(ocean.uniforms).sort(),Object.keys(far.uniforms).sort());
 assert.ok(!('uCascade' in ocean.uniforms));
 // The same range again is not a recompile.
 const off=mesh.material;assert.equal(ocean.setNormalRange(0),0);assert.equal(mesh.material,off);
 assert.equal(ocean.setNormalRange(-5),0);assert.equal(mesh.material,off);
 // Back on: the cascade handed over at the start comes back with it.
 assert.equal(ocean.setNormalRange(400),400);
 assert.equal(mesh.material.fragmentShader,near.mesh.material.fragmentShader);
 assert.equal(mesh.material.vertexShader,near.mesh.material.vertexShader);
 assert.deepEqual(Object.keys(ocean.uniforms).sort(),Object.keys(near.uniforms).sort());
 assert.equal(field.time,23);assert.equal(field.heightAt(-7,12),h);
 assert.throws(()=>ocean.setNormalRange(NaN),TypeError);
 for(const o of [near,far,ocean])o.dispose();
});
