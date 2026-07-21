const fs=require('fs');const path=require('path');const assert=require('assert');
const root=path.join(__dirname,'..','package','shared','ookla-speedtest-web');
for(const f of ['index.html','app.js','styles.css']) assert.ok(fs.existsSync(path.join(root,f)),`missing ${f}`);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'); const js=fs.readFileSync(path.join(root,'app.js'),'utf8'); const css=fs.readFileSync(path.join(root,'styles.css'),'utf8');
assert.match(html,/id=["']go-control["']/); assert.match(html,/History/); assert.match(html,/Analytics/); assert.match(html,/Settings/); assert.match(html,/About/);
assert.match(js,/subscribe\s*\(/); assert.match(js,/navigate\s*\(/); assert.match(js,/call\s*\(/); assert.match(js,/textContent/); assert.doesNotMatch(js,/innerHTML/);
assert.match(js,/router.*internet|internet.*router/i); assert.match(css,/@media/); assert.match(css,/#0?4|navy|cyan/i);
console.log('frontend contract ok');
