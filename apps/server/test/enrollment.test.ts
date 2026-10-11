import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
const hash=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
test("device enrollment proves possession, consumes challenges, gates credentials and revokes every token", async()=>{
 const db=openDatabase(":memory:");let clock=1000;const app=await createApp(db,"https://localhost:8443",{logging:false,now:()=>clock});
 db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"),"csrf",10000000);
 const admin=async(url:string,body:object={})=>app.inject({method:"POST",url,payload:body,headers:{cookie:"session=admin",origin:"https://localhost:8443","x-csrf-token":"csrf"}});
 const keys=generateKeyPairSync("ed25519");const der=keys.publicKey.export({type:"spki",format:"der"}) as Buffer;const public_key=der.toString("base64"),id=hash(der);
 const signed=async(action:string)=>{
  const challenge=(await app.inject({method:"POST",url:"/enrollment/challenge",payload:{}})).json().challenge;
  const payload=JSON.stringify(["willcord-enrollment-v1",action,challenge,public_key,action==="apply"?"test-node":null,action==="apply"?"linux":null,action==="apply"?"x86_64":null]);
  return {public_key,challenge,signature:sign(null,Buffer.from(payload),keys.privateKey).toString("base64"),name:"test-node",os:"linux",arch:"x86_64"};
 };
 const call=async(action:string)=>app.inject({method:"POST",url:`/enrollment/${action}`,payload:await signed(action)});
 try{
  assert.equal((await app.inject({method:"GET",url:"/api/enrollments"})).statusCode,401);
  const proof=await signed("apply");
  assert.equal((await app.inject({method:"POST",url:"/enrollment/apply",payload:{...proof,name:"tampered"}})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:"/enrollment/apply",payload:proof})).json().state,"pending");
  assert.equal((await app.inject({method:"POST",url:"/enrollment/apply",payload:proof})).statusCode,401);
  assert.equal((await call("apply")).statusCode,200);
  assert.equal((await call("credentials")).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:`/api/enrollments/${id}/approve`,payload:{}})).statusCode,401);
  assert.equal((await admin(`/api/enrollments/${id}/approve`)).statusCode,200);
  const first=(await call("credentials")).json().token, second=(await call("credentials")).json().token;
  assert.ok(first&&second&&first!==second);
  assert.notEqual((db.prepare("SELECT revoked_at FROM worker_tokens WHERE digest=?").get(hash(first)) as any).revoked_at,null);
  db.prepare("UPDATE enrollments SET confirmed_digest=pending_digest,pending_digest=NULL WHERE worker_id=?").run(id);
  assert.equal((await call("credentials")).statusCode,409);
  assert.equal((await admin(`/api/enrollments/${id}/revoke`)).statusCode,200);
  assert.equal((await call("credentials")).statusCode,403);
  assert.equal((await admin("/api/worker-tokens",{worker_id:id})).statusCode,403);
  assert.equal(db.prepare("SELECT count(*) FROM worker_tokens WHERE worker_id=? AND revoked_at IS NULL").pluck().get(id),0);
  assert.equal((await call("apply")).json().state,"revoked","reapplying cannot bypass revocation");
  assert.equal((await admin(`/api/enrollments/${id}/approve`)).statusCode,200);
  assert.equal((await call("credentials")).statusCode,200);
  const expired=await signed("status");clock+=300001;
  assert.equal((await app.inject({method:"POST",url:"/enrollment/status",payload:expired})).statusCode,401);
 }finally{await app.close();db.close();}
});

test("enrollment cannot silently adopt a legacy worker ID or accept alternate public-key encodings",async()=>{
 const db=openDatabase(":memory:"),app=await createApp(db,"https://localhost:8443",{logging:false});
 const keys=generateKeyPairSync("ed25519"),der=keys.publicKey.export({type:"spki",format:"der"}) as Buffer,id=hash(der);
 db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(hash("legacy-token"),id);
 const apply=async(raw:Buffer)=>{
  const public_key=raw.toString("base64"),challenge=(await app.inject({method:"POST",url:"/enrollment/challenge",payload:{}})).json().challenge;
  const payload=JSON.stringify(["willcord-enrollment-v1","apply",challenge,public_key,"legacy","linux","x86_64"]);
  return app.inject({method:"POST",url:"/enrollment/apply",payload:{public_key,challenge,signature:sign(null,Buffer.from(payload),keys.privateKey).toString("base64"),name:"legacy",os:"linux",arch:"x86_64"}});
 };
 try{
  assert.equal((await apply(der)).statusCode,409);
  assert.equal(db.prepare("SELECT count(*) FROM enrollments").pluck().get(),0);
  assert.equal((await apply(Buffer.concat([der,Buffer.from([0])]))).statusCode,401);
  assert.equal(db.prepare("SELECT revoked_at FROM worker_tokens").pluck().get(),null,"the original manual token is preserved");
 }finally{await app.close();db.close();}
});
