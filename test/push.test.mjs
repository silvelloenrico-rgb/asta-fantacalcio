import ece from 'http_ece';
import crypto from 'node:crypto';
import { encryptPayload, generateVapidKeys, vapidAuthHeader, b64u, b64uDec } from '../src/push.js';
// fake browser subscription
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const body = await encryptPayload(b64u(ua.getPublicKey()), b64u(auth), JSON.stringify({title:'Ciao',body:'test'}));
const out = ece.decrypt(Buffer.from(body), { version:'aes128gcm', privateKey: ua, authSecret: auth.toString('base64url') });
console.log('decrypted:', out.toString());
// VAPID JWT verify
const v = await generateVapidKeys();
const h = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', v, 'mailto:a@b.c');
const jwt = h.match(/t=([^,]+)/)[1]; const [hd,pl,sg] = jwt.split('.');
const pub = crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:b64u(b64uDec(v.publicKey).slice(1,33)),y:b64u(b64uDec(v.publicKey).slice(33))},format:'jwk'});
console.log('jwt valid:', crypto.verify('sha256', Buffer.from(hd+'.'+pl), {key:pub, dsaEncoding:'ieee-p1363'}, b64uDec(sg)), JSON.parse(Buffer.from(pl,'base64url')));
