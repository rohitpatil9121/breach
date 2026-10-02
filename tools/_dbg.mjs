import { BTN, MOVE, HISTORY } from "file:///D:/3d games/breach/game/data.js";
import { quantizeYaw, quantizePitch, findPlayer } from "file:///D:/3d games/breach/game/sim.js";
import { Client, Loopback, Conditions } from "file:///D:/3d games/breach/game/net.js";
import { Room } from "file:///D:/3d games/breach/server/room.mjs";
let now=0; const room=new Room({map:"foundry",length:1e5,scoreLimit:1e5});
const mk=(s,n)=>{const c=new Client(),l=new Conditions(new Loopback(room),{...s,now:()=>now,random:Math.random});c.attach(l);l.connect(n);c.controls={mx:0,my:0,buttons:0,weapon:0,yaw:0,pitch:0};return c};
const a=mk({latency:0},"A"), b=mk({latency:0},"B");
const step=(each)=>{now+=1000/60;for(const c of [a,b]){c.frame(1/60);each&&each(c);c.tick(c.controls)}room.tick()};
for(let i=0;i<60;i++)step();
const pa=findPlayer(room.state,a.id),pb=findPlayer(room.state,b.id);
const place=(p,x,y)=>{Object.assign(p,{x,y,z:0,vx:0,vy:0,vz:0,ground:true,protect:0});for(let i=0;i<p.hist.length;i+=4){p.hist[i]=x;p.hist[i+1]=y;p.hist[i+2]=0}};
place(pa,-14,-12);place(pb,-14,9.5);pa.has|=8;pa.ammo[3]=18;a.controls.weapon=4;
for(let i=0;i<90;i++)step();
let t=0;const s={};
a.on("event",e=>{if(e.type==="hurt"&&e.by===a.id)console.log("   HIT")});
for(let i=0;i<71*8;i++){
  let fire=false,seen=0,vt=0;
  step((c)=>{ if(c===b){t++;c.controls.yaw=quantizeYaw(-Math.PI/2);c.controls.mx=t%72<36?127:-127;return}
    pb.health=100;pa.ammo[3]=18; if(!c.sample(b.id,s))return; const me=c.me,dx=s.x-me.x,dy=s.y-me.y,dz=s.z+1-(me.z+MOVE.eye);
    c.controls.weapon=0;c.controls.yaw=quantizeYaw(Math.atan2(dy,dx));c.controls.pitch=quantizePitch(Math.atan2(dz,Math.hypot(dx,dy)));
    c.controls.buttons=BTN.zoom|(t%71===5?BTN.fire:0); if(t%71===5){fire=true;seen=s.x;vt=c.renderTick} });
  if(fire){const T=room.state.tick; const lag=room.clients.get(a.id).last.lag; const h=(k)=>pb.hist[((k)&(HISTORY-1))*4];
    console.log(`T=${T} vt=${vt.toFixed(2)} lag=${lag} seenX=${seen.toFixed(3)} histAt(vt)=${h(Math.round(vt)).toFixed(3)} nowX=${pb.x.toFixed(3)} weapon=${pa.weapon} zoom=${pa.zoom} cool=${pa.cool} serverTick(client)=${a.serverTick} yawA=${pa.yaw} pitchA=${pa.pitch} seq=${pa.seq}`)}
}
