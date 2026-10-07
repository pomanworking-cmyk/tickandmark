import sys, os, numpy as np
from PIL import Image
SRC='/mnt/user-data/uploads'
MAP={'A6B06C9E':'fire_fox','D3E11D92':'metal_cat','0FC10B6E':'wood_deer','5FFF61D8':'water_otter',
     '30E2E03C':'earth_bear','08E5815B':'metal_bird','698D70AD':'wood_rabbit','89FDF40E':'water_koi'}
STAGES=['egg','baby','junior','adult','evolved']
EXP=[(330,420),(715,800),(1080,1160),(1540,1620)]
out=sys.argv[1]
for pre,key in MAP.items():
    f=[x for x in os.listdir(SRC) if x.startswith(pre)][0]
    im=Image.open(os.path.join(SRC,f)).convert('RGBA'); a=np.array(im)[:,:,3]
    col=(a>40).sum(0).astype(float)
    cuts=[0]
    for lo,hi in EXP:
        seg=col[lo:hi]; m=seg.min(); idx=np.where(seg==m)[0]; cuts.append(lo+int(idx[len(idx)//2]))
    cuts.append(im.width)
    os.makedirs(f'{out}/{key}',exist_ok=True)
    for i,st in enumerate(STAGES):
        c=im.crop((cuts[i],0,cuts[i+1],im.height))
        ca=np.array(c)[:,:,3]; ys,xs=np.where(ca>8)
        c=c.crop((xs.min(),ys.min(),xs.max()+1,ys.max()+1))
        # pad to square, max side 512
        s=max(c.size); sq=Image.new('RGBA',(s,s),(0,0,0,0)); sq.paste(c,((s-c.width)//2,s-c.height))
        sq=sq.resize((512,512),Image.LANCZOS) if s>512 else sq
        sq.save(f'{out}/{key}/{st}.webp','WEBP',quality=88,method=2)
    print(key,cuts)
