import json, re, sys, base64, gzip
src = open(sys.argv[1]).read()
def block(t):
    m = re.search(r'<script type="__bundler/%s"[^>]*>(.*?)</script>' % t, src, re.S)
    return m.group(1) if m else None
tpl = json.loads(block("template"))
man = json.loads(block("manifest"))
print("template len", len(tpl))
print("manifest entries", len(man), [ (k, v.get("mime") if isinstance(v,dict) else type(v).__name__, len(json.dumps(v))) for k,v in list(man.items())[:20]])
print("page_order", block("page_order")[:300])
open(sys.argv[2],"w").write(tpl)
