import sys, os, glob, collections
root, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
files = [p for p in glob.glob(root+'/**/*', recursive=True) if os.path.isfile(p)]
ext = collections.Counter(os.path.splitext(p)[1] for p in files)
with open(out+'/probe.txt','w') as f:
    f.write(f"files {len(files)}\next {ext}\n")
    for p in sorted(files)[:40]:
        f.write(f"{os.path.relpath(p,root)} {os.path.getsize(p)}\n")
    for p in sorted(files)[:3]:
        f.write(f"\n==== {p}\n")
        with open(p,'rb') as g: f.write(g.read(1500).decode('utf8','replace'))
    for p in sorted(files)[-1:]:
        f.write(f"\n==== TAIL {p}\n")
        with open(p,'rb') as g:
            g.seek(max(0,os.path.getsize(p)-800)); f.write(g.read().decode('utf8','replace'))
    f.write("\nALL:\n"+"\n".join(os.path.relpath(p,root) for p in sorted(files)))
