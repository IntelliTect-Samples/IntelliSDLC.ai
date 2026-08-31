const harPolicy = require('./har-policy.js');
const pii = require('./pii.js');
const harShapes = require('./har-shapes.js');
const path = require('path');

const policyPath = 'C:\\Git\\IntelliSDLC.ai\\.worktrees\\297-docs\\tmp_policytest\\.har-policy.project.json';
const policy = harPolicy.loadPolicy({ policyPath });
console.log("Loaded OK. classes.identity.person-name =", policy.classes.identity['person-name']);
console.log("identifierFields:", policy.identifierFields);

function luhn(s){let sum=0,alt=false;for(let i=s.length-1;i>=0;i--){let n=parseInt(s[i],10);if(alt){n*=2;if(n>9)n-=9;}sum+=n;alt=!alt;}return sum%10===0;}
let card=null;
for (let i=0;i<200000 && !card;i++){
  const cand = "4" + String(Math.floor(Math.random()*1e15)).padStart(15,'0');
  if (luhn(cand)) card = cand;
}
console.log("card-shaped trip_id value:", card);
console.log("hasAssignedIin:", harShapes.hasAssignedIin(card, policy));

const har = {
  log: {
    entries: [
      {
        request: {
          url: 'https://example.com/api/trips',
          headers: [{name:'x-my-app-token', value:'sekrit-abc-123'}, {name:'x-asbd-id', value:'129477'}],
          cookies: [],
          queryString: [],
          postData: { mimeType: 'application/json', text: JSON.stringify({ trip_id: card, step_id: card, city: "Seattle" }) }
        },
        response: {
          content: { mimeType: 'application/json', text: JSON.stringify({ trip_id: card }) }
        }
      }
    ]
  }
};

const detections = pii.detectPii(har, policy);
console.log("Detections:", JSON.stringify(detections.map(d=>({type:d.type, value: d.value})), null, 2));

const result = pii.scrubPii(har, policy);
console.log("Scrubbed postData.text:", har.log.entries[0].request.postData.text);
console.log("Scrubbed response.text:", har.log.entries[0].response.content.text);
console.log("Substitutions:", JSON.stringify(result.substitutions, null, 2));

// Now test gate side: findLeaksInHar / blocksLeak
const leaks = harShapes.findLeaksInHar(har, policy);
console.log("Leaks (gate view):", JSON.stringify(leaks.map(l=>({kind:l.kind, class:l.class, identifierField:l.identifierField, gating:l.gating})), null, 2));
