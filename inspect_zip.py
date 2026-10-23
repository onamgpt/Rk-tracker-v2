import zipfile, itertools, sys
z = zipfile.ZipFile(sys.argv[1])
L = z.infolist(); print('entries', len(L), 'total_uncompressed_GB', round(sum(i.file_size for i in L)/1e9, 2))
for i in L[:15]: print(i.filename, i.file_size, i.compress_type)
with z.open(L[0]) as f:
    for line in itertools.islice(f, 8): print(line[:300])
z.extractall(sys.argv[2]); print('extracted ok')
