import re, json, sys
bundle, newtpl = sys.argv[1], sys.argv[2]
src = open(bundle, encoding="utf-8").read()
tpl = open(newtpl, encoding="utf-8").read()
enc = json.dumps(tpl, ensure_ascii=False).replace("</", "<\\u002f")
assert json.loads(enc) == tpl
m = re.search(r'(<script type="__bundler/template"[^>]*>)(.*?)(</script>)', src, re.S)
out = src[:m.start(2)] + enc + src[m.end(2):]
open(bundle, "w", encoding="utf-8").write(out)
print(bundle, "repacked", len(src), "->", len(out))
