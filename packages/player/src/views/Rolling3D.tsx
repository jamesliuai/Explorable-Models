import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RotateCcw, RotateCw } from 'lucide-react';
import type { RunFrame, ScalarParams, ViewState } from '@explorable-models/core';
import { vector, scalar } from '../utils';
export default function Rolling3D({frame,parameters:p,camera,onCamera}:{frame:RunFrame;parameters:ScalarParams;camera?:ViewState['camera'];onCamera:(camera:NonNullable<ViewState['camera']>)=>void}) {
 const ref=useRef<HTMLDivElement>(null);const live=useRef<{body:THREE.Group;render:()=>void;controls:OrbitControls;camera:THREE.PerspectiveCamera;reset:()=>void}|undefined>(undefined);const [error,setError]=useState('');
 const currentCamera=useRef(camera),commitCamera=useRef(onCamera);currentCamera.current=camera;commitCamera.current=onCamera;
 useEffect(()=>{
  if(!ref.current)return;const host=ref.current;let renderer:THREE.WebGLRenderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{setError('3D is unavailable in this browser. The 2D view and quantities show the complete experiment.');return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xf4f8fc,1);host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','Orbitable rolling body. Camera buttons provide an alternative to dragging.');
  const scene=new THREE.Scene();const cam=new THREE.PerspectiveCamera(36,1,.01,200);const l=Number(p.length),a=Number(p.incline),r=Number(p.radius);
  const target=new THREE.Vector3(l*Math.cos(a)/2,l*Math.sin(a)/2,0);
  cam.position.set(target.x+2,target.y+2,l*1.6+2);cam.lookAt(target);
  const controls=new OrbitControls(cam,renderer.domElement);controls.target.copy(target);controls.enableDamping=false;controls.minDistance=.8;controls.maxDistance=30;controls.maxPolarAngle=Math.PI*.95;
  if(currentCamera.current){cam.position.fromArray(currentCamera.current.position);controls.target.fromArray(currentCamera.current.target);}
  // OrbitControls initializes toward the origin; apply our actual target before
  // calculating the frustum or drawing the first frame.
  controls.update();
  scene.add(new THREE.AmbientLight(0xffffff,2));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(-3,8,6);scene.add(light);
  const ramp=new THREE.Mesh(new THREE.BoxGeometry(l,.045,Math.max(.7,r*3.5)),new THREE.MeshStandardMaterial({color:0xdce6f0,roughness:.9}));ramp.position.copy(target).add(new THREE.Vector3(-Math.sin(a)*.0225,-Math.cos(a)*.0225,0));ramp.rotation.z=-a;scene.add(ramp);
  const edges=new THREE.LineSegments(new THREE.EdgesGeometry(ramp.geometry),new THREE.LineBasicMaterial({color:0x90a5bc}));ramp.add(edges);
  const body=new THREE.Group();const material=new THREE.MeshStandardMaterial({color:0x2874f0,roughness:.45,metalness:.02});let shape:THREE.BufferGeometry;
  if(p.bodyType==='hoop'){shape=new THREE.TorusGeometry(r*.91,r*.09,12,64);}else if(p.bodyType==='cylinder'){shape=new THREE.CylinderGeometry(r,r,r*1.1,48);shape.rotateX(Math.PI/2);}else{shape=new THREE.SphereGeometry(r,40,24);}
  const mesh=new THREE.Mesh(shape,material);body.add(mesh);
  if(p.bodyType==='shell'){material.transparent=true;material.opacity=.35;const wire=new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(r,12,8)),new THREE.LineBasicMaterial({color:0x1765c9}));body.add(wire);}
  const mark=new THREE.Mesh(new THREE.TorusGeometry(r*1.003,.009,8,72),new THREE.MeshBasicMaterial({color:0xddeaff}));body.add(mark);
  const meridian=mark.clone();meridian.rotation.y=Math.PI/2;body.add(meridian);
  const spoke=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,r*.98),new THREE.Vector3(r*.85,0,r*.53)]),new THREE.LineBasicMaterial({color:0xffffff}));body.add(spoke);scene.add(body);
  const axes=new THREE.AxesHelper(.35);axes.position.set(-.2,-.12,0);scene.add(axes);
  // Include the body's complete trajectory, not just its current position, so
  // playback never pans or zooms and the terminal body stays inside the frame.
  scene.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(ramp);
  const extent=r*1.003+.009; // Include the orientation marker's outer surface.
  for(const distance of [0,l]){
   const center=new THREE.Vector3(distance*Math.cos(a)+r*Math.sin(a),(l-distance)*Math.sin(a)+r*Math.cos(a),0);
   bounds.expandByPoint(center.clone().addScalar(extent));bounds.expandByPoint(center.clone().addScalar(-extent));
  }
  bounds.union(new THREE.Box3().setFromObject(axes));
  const corners=[bounds.min.x,bounds.max.x].flatMap(x=>[bounds.min.y,bounds.max.y].flatMap(y=>[bounds.min.z,bounds.max.z].map(z=>new THREE.Vector3(x,y,z))));
  const fitDefaultCamera=()=>{
   controls.target.copy(target);
   const direction=new THREE.Vector3(2,2,l*1.6+2).normalize();
   cam.position.copy(target).add(direction);controls.update();cam.updateMatrixWorld();
   const right=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,0),up=new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld,1);
   const vertical=Math.tan(THREE.MathUtils.degToRad(cam.fov/2))*.84,horizontal=vertical*cam.aspect;
   let distance=controls.minDistance;
   for(const corner of corners){
    const offset=corner.clone().sub(target),depth=offset.dot(direction);
    distance=Math.max(distance,depth+Math.abs(offset.dot(right))/horizontal,depth+Math.abs(offset.dot(up))/vertical);
   }
   cam.position.copy(target).addScaledVector(direction,distance);controls.update();
  };
  const render=()=>renderer.render(scene,cam);
  const resize=()=>{const {width,height}=host.getBoundingClientRect();if(!width||!height)return;renderer.setSize(width,height);cam.aspect=width/height;cam.updateProjectionMatrix();if(!currentCamera.current)fitDefaultCamera();render();};
  const reset=()=>{fitDefaultCamera();render();commitCamera.current({position:cam.position.toArray(),target:controls.target.toArray()});};
  const observer=new ResizeObserver(resize);observer.observe(host);
  controls.addEventListener('change',render);controls.addEventListener('end',()=>commitCamera.current({position:cam.position.toArray(),target:controls.target.toArray()}));live.current={body,render,controls,camera:cam,reset};resize();
  return()=>{live.current=undefined;observer.disconnect();controls.dispose();scene.traverse(obj=>{if(obj instanceof THREE.Mesh||obj instanceof THREE.Line){obj.geometry.dispose();const materials=Array.isArray(obj.material)?obj.material:[obj.material];materials.forEach(m=>m.dispose());}});renderer.dispose();renderer.domElement.remove();};
 },[p.bodyType,p.radius,p.length,p.incline]);
 useEffect(()=>{const scene=live.current;if(!scene)return;scene.body.position.fromArray(vector(frame,'body.position'));scene.body.rotation.z=scalar(frame,'body.rotation');scene.render();},[frame,p]);
 useEffect(()=>{const scene=live.current;if(!scene||!camera)return;scene.camera.position.fromArray(camera.position);scene.controls.target.fromArray(camera.target);scene.controls.update();scene.render();},[camera]);
 const rotate=(amount:number)=>{const s=live.current;if(!s)return;const offset=s.camera.position.clone().sub(s.controls.target).applyAxisAngle(new THREE.Vector3(0,1,0),amount);s.camera.position.copy(s.controls.target).add(offset);s.controls.update();onCamera({position:s.camera.position.toArray(),target:s.controls.target.toArray()});};
 const reset=()=>live.current?.reset();
 return <div className="three-wrap" data-frame-id={frame.frameId} data-quantity-id="body.rotation" data-value={scalar(frame,'body.rotation')}><div ref={ref} className="three-canvas"/>{error?<p className="three-error" role="status">{error}</p>:null}<div className="camera-controls"><button onClick={()=>rotate(-.25)} aria-label="Orbit camera left"><RotateCcw size={14}/></button><button onClick={()=>rotate(.25)} aria-label="Orbit camera right"><RotateCw size={14}/></button><button onClick={reset}>Reset camera</button><span>Primary body · comparison in charts</span></div></div>;
}
