# Isku xir badhanka Report ee SoomaaLink iyo server-ka Render
import os, sys, shutil

D = os.path.expanduser("~/storage/downloads/")
SRC = D + "index.html"
BAK = D + "index.before-report.html"

s = open(SRC, encoding="utf-8").read()
if "REPORT_API" in s:
    print("Horey ayaa loo dhejiyay. Waxba lama beddelin.")
    sys.exit(0)

shutil.copyfile(SRC, BAK)

pairs = [
    ('onclick="sendReport()"><span data-i="rp1">', "onclick=\"sendReport('not_family_safe')\"><span data-i=\"rp1\">"),
    ('onclick="sendReport()"><span data-i="rp2">', "onclick=\"sendReport('violence')\"><span data-i=\"rp2\">"),
    ('onclick="sendReport()"><span data-i="rp3">', "onclick=\"sendReport('fake_news')\"><span data-i=\"rp3\">"),
    ('onclick="sendReport()"><span data-i="rp4">', "onclick=\"sendReport('spam')\"><span data-i=\"rp4\">"),
]
for old, new in pairs:
    if s.count(old) != 1:
        print("KHALAD: ma helin:", old)
        sys.exit(1)
    s = s.replace(old, new)

old_fn = "function sendReport(){closeOv(null,'rpOv');toast(T('reported'))}"
if s.count(old_fn) != 1:
    print("KHALAD: function sendReport ma helin")
    sys.exit(1)

new_fn = r"""const REPORT_API='https://soomaalink-api.onrender.com';
function reportUserId(){
  try{ if(S&&S.me&&S.me.handle) return String(S.me.handle); }catch(e){}
  try{
    let d=localStorage.getItem('sl_dev');
    if(!d){ d='guest-'+Math.random().toString(36).slice(2,10); localStorage.setItem('sl_dev',d); }
    return d;
  }catch(e){ return 'guest-anon'; }
}
function sendReport(reason){
  closeOv(null,'rpOv');
  const id=shId;
  const v=(id&&id!=='__p')?vid(id):null;
  if(!v){ toast(T('reported')); return; }
  fetch(REPORT_API+'/api/reports',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-user-id':reportUserId()},
    body:JSON.stringify({target_type:'video',target_id:String(v.id),target_owner:String(v.owner),reason:reason||'other'})
  }).then(r=>{
    if(r.ok||r.status===409||r.status===400) toast(T('reported'));
    else toast(B('Khalad, isku day mar kale','Error, please try again'));
  }).catch(()=>toast(B('Khalad, isku day mar kale','Error, please try again')));
}"""
s = s.replace(old_fn, new_fn)

open(SRC, "w", encoding="utf-8").write(s)
print("WAA GUULEYSTAY. Nuqulka hore: index.before-report.html")
print("Cabbirka cusub:", len(s.encode('utf-8')), "byte")
