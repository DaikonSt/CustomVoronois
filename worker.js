'use strict';
// ═══ Optimised Voronoi Treemap Worker ═══════════════════════════════════════
// Speed gains over previous version
//  1. Only iterate pixels INSIDE the current mask (not the full gs² grid)
//  2. Precompute (x,y) for every inside-pixel — eliminates idx%gs / idx/gs|0 in hot loop
//  3. Typed arrays for site coords (Float64Array) — faster than object-property access
//  4. Single pre-allocated Int32Array for cells, reused across all Lloyd iterations
//  5. lloydStep & extractRegionData also iterate inside[] only
//  6. Adaptive iteration count: fewer iters converge with better weight step

// ─── Numeric parsing ─────────────────────────────────────────────────────────
function parseNumeric(raw) {
  if (raw==null) return 0;
  var s=String(raw).trim(); if(!s) return 0;
  var upper=s.toUpperCase(), mult=1;
  if(/[0-9]\s*T/.test(upper)) mult=1e12;
  else if(/[0-9]\s*B/.test(upper)) mult=1e9;
  else if(/[0-9]\s*M/.test(upper)) mult=1e6;
  else if(/[0-9]\s*K/.test(upper)) mult=1e3;
  var neg=/^\(.*\)$/.test(s);
  var clean=s.replace(/[^0-9.,\-]/g,'');
  if(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(clean)) clean=clean.replace(/\./g,'').replace(',','.');
  else clean=clean.replace(/,/g,'');
  var v=parseFloat(clean); if(isNaN(v)) return 0;
  return (neg?-v:v)*mult;
}

// ─── CSV ─────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  var rows=[], lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  for(var i=0;i<lines.length;i++){var l=lines[i].trim();if(l)rows.push(parseCSVLine(l));}
  return rows;
}
function parseCSVLine(line) {
  var f=[],cur='',inQ=false;
  for(var i=0;i<line.length;i++){
    var c=line[i];
    if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}
    else if(c===','&&!inQ){f.push(cur.trim());cur='';}
    else cur+=c;
  }
  f.push(cur.trim()); return f;
}

// ─── Tree ────────────────────────────────────────────────────────────────────
function buildTree(rows, hierCols, valueCol) {
  var headers=rows[0], colIdx={};
  for(var i=0;i<headers.length;i++) colIdx[headers[i]]=i;
  var hIdx=hierCols.map(function(h){return colIdx[h];}), vIdx=colIdx[valueCol];
  var root={name:'root',children:[],value:0};
  for(var r=1;r<rows.length;r++){
    var row=rows[r]; if(!row||!row.length) continue;
    var val=parseNumeric(row[vIdx]); if(val<=0) continue;
    var node=root;
    for(var d=0;d<hIdx.length;d++){
      var key=row[hIdx[d]]||'(blank)', found=null;
      for(var c=0;c<node.children.length;c++) if(node.children[c].name===key){found=node.children[c];break;}
      if(!found){found={name:key,children:[],value:0};node.children.push(found);}
      node=found;
    }
    node.value+=val;
  }
  function rollup(n){
    if(!n.children.length) return n.value;
    var s=0; for(var i=0;i<n.children.length;i++) s+=rollup(n.children[i]);
    n.value=s; return s;
  }
  rollup(root); return root;
}

// ─── Colours ─────────────────────────────────────────────────────────────────
var PALETTES={
  auto:      ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac','#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00','#a65628','#f781bf','#66c2a5','#fc8d62','#8da0cb'],
  tableau:   ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'],
  pastel:    ['#aec6cf','#ffb347','#b39eb5','#ff6961','#77dd77','#fdfd96','#dea5a4','#87ceeb','#cfcfc4','#f49ac2'],
  vivid:     ['#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00','#a65628','#f781bf','#999','#66c2a5','#fc8d62'],
  earthy:    ['#8b4513','#a0785a','#c4a882','#6b8e23','#556b2f','#8fbc8f','#b8860b','#cd853f','#daa520','#bc8f8f'],
  monochrome:['#111','#333','#555','#777','#999','#aaa','#bbb','#ccc','#ddd','#eee']
};
function h2(v){var s=Math.max(0,Math.min(255,Math.round(v))).toString(16);return s.length<2?'0'+s:s;}
function blendW(hex,t){var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return'#'+h2(r+(255-r)*t)+h2(g+(255-g)*t)+h2(b+(255-b)*t);}
function assignColors(node,palette){
  var cols=PALETTES[palette]||PALETTES.auto;
  for(var i=0;i<node.children.length;i++) colorSubtree(node.children[i],cols[i%cols.length],0);
}
function colorSubtree(node,base,depth){
  node._color=blendW(base,depth*0.15);
  for(var i=0;i<node.children.length;i++) colorSubtree(node.children[i],base,depth+1);
}

// ─── SVG path parser (full spec) ─────────────────────────────────────────────
function parseSVGPath(d){
  var tokens=[],re=/([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g,m;
  while((m=re.exec(d))!==null) tokens.push(m[1]?{t:'c',v:m[1]}:{t:'n',v:parseFloat(m[2])});
  var cmds=[],i=0;
  function nums(n){var o=[];while(o.length<n&&i<tokens.length&&tokens[i].t==='n')o.push(tokens[i++].v);return o;}
  while(i<tokens.length){
    if(tokens[i].t!=='c'){i++;continue;}
    var cmd=tokens[i++].v,up=cmd.toUpperCase(),rel=cmd!==up;
    if(up==='Z'){cmds.push({cmd:'Z',rel:false,args:[]});continue;}
    var cnt={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7}[up]||2;
    var first=true;
    while(true){
      var args=nums(cnt); if(args.length<cnt) break;
      cmds.push({cmd:first?up:(up==='M'?'L':up),rel:rel,args:args}); first=false;
      if(i>=tokens.length||tokens[i].t==='c') break;
    }
  }
  return cmds;
}
function cubicPts(x0,y0,x1,y1,x2,y2,x3,y3,add){
  for(var k=1;k<=24;k++){var u=k/24,mu=1-u;add(mu*mu*mu*x0+3*mu*mu*u*x1+3*mu*u*u*x2+u*u*u*x3,mu*mu*mu*y0+3*mu*mu*u*y1+3*mu*u*u*y2+u*u*u*y3);}
}
function quadPts(x0,y0,x1,y1,x2,y2,add){
  for(var k=1;k<=16;k++){var u=k/16,mu=1-u;add(mu*mu*x0+2*mu*u*x1+u*u*x2,mu*mu*y0+2*mu*u*y1+u*u*y2);}
}
function arcPts(x1,y1,rx,ry,xRot,lA,sw,x2,y2,add){
  if(!rx||!ry){add(x2,y2);return;}
  var phi=xRot*Math.PI/180,cp=Math.cos(phi),sp=Math.sin(phi);
  var dx=(x1-x2)/2,dy=(y1-y2)/2,xp=cp*dx+sp*dy,yp=-sp*dx+cp*dy;
  rx=Math.abs(rx);ry=Math.abs(ry);
  var xp2=xp*xp,yp2=yp*yp,rx2=rx*rx,ry2=ry*ry;
  var lam=xp2/rx2+yp2/ry2; if(lam>1){var sl=Math.sqrt(lam);rx*=sl;ry*=sl;rx2=rx*rx;ry2=ry*ry;}
  var num=rx2*ry2-rx2*yp2-ry2*xp2,den=rx2*yp2+ry2*xp2;
  var sq=den?Math.sqrt(Math.max(0,num/den)):0,sgn=(lA===sw)?-1:1;
  var cxp=sgn*sq*rx*yp/ry,cyp=-sgn*sq*ry*xp/rx;
  var cx2=cp*cxp-sp*cyp+(x1+x2)/2,cy2=sp*cxp+cp*cyp+(y1+y2)/2;
  var ux=(xp-cxp)/rx,uy=(yp-cyp)/ry,vx=(-xp-cxp)/rx,vy=(-yp-cyp)/ry;
  var a1=Math.atan2(uy,ux),aD=Math.atan2(vy,vx)-a1;
  if(!sw&&aD>0)aD-=2*Math.PI; if(sw&&aD<0)aD+=2*Math.PI;
  var steps=Math.max(8,Math.ceil(Math.abs(aD)*14));
  for(var k=1;k<=steps;k++){var a=a1+aD*k/steps;add(cp*rx*Math.cos(a)-sp*ry*Math.sin(a)+cx2,sp*rx*Math.cos(a)+cp*ry*Math.sin(a)+cy2);}
}
function pathToPolylines(cmds,offX,offY,scaleX,scaleY){
  var polys=[],cur=null,cx=0,cy=0,sx=0,sy=0,lCmd='',lCPX=0,lCPY=0,lQX=0,lQY=0;
  function tx(x){return(x-offX)*scaleX;} function ty(y){return(y-offY)*scaleY;}
  function add(x,y){if(!cur){cur=[];polys.push(cur);}cur.push({x:tx(x),y:ty(y)});}
  function mv(x,y){if(cur&&cur.length>1)cur.push({x:tx(sx),y:ty(sy)});cur=null;cx=x;cy=y;sx=x;sy=y;add(x,y);}
  for(var i=0;i<cmds.length;i++){
    var s=cmds[i],a=s.args,rel=s.rel,ox=rel?cx:0,oy=rel?cy:0;
    switch(s.cmd){
      case'M':mv(ox+a[0],oy+a[1]);lCmd='M';break;
      case'L':cx=ox+a[0];cy=oy+a[1];add(cx,cy);lCmd='L';break;
      case'H':cx=ox+a[0];add(cx,cy);lCmd='H';break;
      case'V':cy=oy+a[0];add(cx,cy);lCmd='V';break;
      case'C':{var x1=ox+a[0],y1=oy+a[1],x2=ox+a[2],y2=oy+a[3],x=ox+a[4],y=oy+a[5];cubicPts(cx,cy,x1,y1,x2,y2,x,y,add);lCPX=x2;lCPY=y2;cx=x;cy=y;lCmd='C';break;}
      case'S':{var rx1='CS'.indexOf(lCmd)>=0?2*cx-lCPX:cx,ry1='CS'.indexOf(lCmd)>=0?2*cy-lCPY:cy,x2=ox+a[0],y2=oy+a[1],x=ox+a[2],y=oy+a[3];cubicPts(cx,cy,rx1,ry1,x2,y2,x,y,add);lCPX=x2;lCPY=y2;cx=x;cy=y;lCmd='S';break;}
      case'Q':{var x1=ox+a[0],y1=oy+a[1],x=ox+a[2],y=oy+a[3];quadPts(cx,cy,x1,y1,x,y,add);lQX=x1;lQY=y1;cx=x;cy=y;lCmd='Q';break;}
      case'T':{var qx1='QT'.indexOf(lCmd)>=0?2*cx-lQX:cx,qy1='QT'.indexOf(lCmd)>=0?2*cy-lQY:cy,x=ox+a[0],y=oy+a[1];quadPts(cx,cy,qx1,qy1,x,y,add);lQX=qx1;lQY=qy1;cx=x;cy=y;lCmd='T';break;}
      case'A':arcPts(cx,cy,a[0],a[1],a[2],!!a[3],!!a[4],ox+a[5],oy+a[6],add);cx=ox+a[5];cy=oy+a[6];lCmd='A';break;
      case'Z':if(cur){cur.push({x:tx(sx),y:ty(sy)});cur=null;}cx=sx;cy=sy;lCmd='Z';break;
    }
  }
  return polys.filter(function(p){return p&&p.length>=2;});
}

// ─── Scanline rasteriser (accurate area for custom SVG) ───────────────────────
function scanlineFill(polys,gs){
  var mask=new Uint8Array(gs*gs);
  for(var y=0;y<gs;y++){
    var scanY=y+0.5,xs=[];
    for(var pi=0;pi<polys.length;pi++){
      var poly=polys[pi];
      for(var j=0;j<poly.length-1;j++){
        var p0=poly[j],p1=poly[j+1];
        if((p0.y<=scanY&&p1.y>scanY)||(p1.y<=scanY&&p0.y>scanY))
          xs.push(p0.x+(scanY-p0.y)/(p1.y-p0.y)*(p1.x-p0.x));
      }
    }
    xs.sort(function(a,b){return a-b;});
    for(var k=0;k+1<xs.length;k+=2){
      var x0=Math.max(0,Math.ceil(xs[k])),x1=Math.min(gs-1,Math.floor(xs[k+1]));
      for(var x=x0;x<=x1;x++) mask[y*gs+x]=1;
    }
  }
  return mask;
}
// Compute a uniform (aspect-ratio-preserving) transform from SVG viewBox → gs×gs grid.
// Uses the same scale for both X and Y (min of the two fits), centered in the grid.
// pathToPolylines uses tx(x)=(x-offXParam)*scaleX, so we solve for offXParam such that
//   tx(x) = (x-vb[0])*scale + gsCenterOffX
// giving offXParam = vb[0] - gsCenterOffX/scale.
function svgUniformTransform(gs,vb){
  var scale=Math.min(gs/vb[2],gs/vb[3]);
  var gsCx=(gs-vb[2]*scale)/2, gsCy=(gs-vb[3]*scale)/2;
  return {scale:scale, offX:vb[0]-gsCx/scale, offY:vb[1]-gsCy/scale};
}

function makeSVGMask(gs,svgData){
  var vb=svgData.viewBox, t=svgUniformTransform(gs,vb);
  var allPoly=[];
  for(var i=0;i<svgData.paths.length;i++){
    var pp=pathToPolylines(parseSVGPath(svgData.paths[i]),t.offX,t.offY,t.scale,t.scale);
    for(var j=0;j<pp.length;j++) allPoly.push(pp[j]);
  }
  return scanlineFill(allPoly,gs);
}

// ─── Standard mask generators ─────────────────────────────────────────────────
function makeCircleMask(gs){
  var mask=new Uint8Array(gs*gs),cx=gs/2-.5,cy=gs/2-.5,r=gs/2-2;
  for(var y=0;y<gs;y++){var dy2=(y-cy)*(y-cy);for(var x=0;x<gs;x++){var dx=x-cx;if(dx*dx+dy2<=r*r)mask[y*gs+x]=1;}}
  return mask;
}
function makeSquareMask(gs){
  var mask=new Uint8Array(gs*gs),pad=Math.max(2,gs*.02|0);
  for(var y=pad;y<gs-pad;y++) for(var x=pad;x<gs-pad;x++) mask[y*gs+x]=1;
  return mask;
}
function makeTriangleMask(gs){
  // pad matches triangleContainerPoly exactly.
  // h = gs-2*pad-1 so that f=1 at y=gs-pad-1 (the last filled row = the container's bottom vertex row),
  // giving hw=0 there — matching the container's apex. Using gs-2*pad caused a ~0.9% slope error.
  var mask=new Uint8Array(gs*gs),pad=Math.max(1,gs*.04|0),h=Math.max(1,gs-2*pad-1);
  for(var y=pad;y<gs-pad;y++){var f=(y-pad)/h,hw=(gs/2-pad)*(1-f),cx=gs/2;for(var x=Math.floor(cx-hw);x<=Math.ceil(cx+hw);x++)if(x>=0&&x<gs)mask[y*gs+x]=1;}
  return mask;
}
function makePolyMask(gs,sides){
  var mask=new Uint8Array(gs*gs),cx=gs/2-.5,cy=gs/2-.5,r=gs/2-2,verts=[];
  for(var i=0;i<sides;i++){var a=2*Math.PI*i/sides-Math.PI/2;verts.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});}
  function pip(px,py){var inside=false,n=verts.length;for(var i=0,j=n-1;i<n;j=i++){var xi=verts[i].x,yi=verts[i].y,xj=verts[j].x,yj=verts[j].y;if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;}return inside;}
  for(var y=0;y<gs;y++) for(var x=0;x<gs;x++) if(pip(x,y)) mask[y*gs+x]=1;
  return mask;
}

// ─── Polygon helpers ──────────────────────────────────────────────────────────
function polyArea(pts){
  var a=0,n=pts.length;
  for(var i=0;i<n;i++){var j=(i+1)%n;a+=pts[i].x*pts[j].y-pts[j].x*pts[i].y;}
  return Math.abs(a)/2;
}
function pointInPoly(px,py,poly){
  var inside=false,n=poly.length;
  for(var i=0,j=n-1;i<n;j=i++){
    var xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

// ─── Convexity check + ear-clipping triangulation ─────────────────────────────
// Sutherland-Hodgman clipping is only correct for CONVEX clipping polygons.
// Non-convex containers (stars, L-shapes, crescents…) must be decomposed into
// triangles first — each triangle is always convex, so SH is exact on them.

function isConvexPoly(poly){
  var n=poly.length; if(n<3) return false; if(n===3) return true;
  var sign=0;
  for(var i=0;i<n;i++){
    var a=poly[i],b=poly[(i+1)%n],c=poly[(i+2)%n];
    var cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if(Math.abs(cross)<1e-10) continue; // collinear edge, skip
    if(sign===0) sign=cross>0?1:-1;
    else if((cross>0?1:-1)!==sign) return false;
  }
  return true;
}

// Point-in-triangle test (works for any orientation).
function ptInTri(p,a,b,c){
  var d1=(p.x-b.x)*(a.y-b.y)-(a.x-b.x)*(p.y-b.y);
  var d2=(p.x-c.x)*(b.y-c.y)-(b.x-c.x)*(p.y-c.y);
  var d3=(p.x-a.x)*(c.y-a.y)-(c.x-a.x)*(p.y-a.y);
  return !((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0));
}

// Ear-clipping triangulation for any simple polygon (convex or non-convex).
// Returns an array of [p0,p1,p2] triangles covering the polygon's interior exactly.
function earClipTriangulate(poly){
  if(poly.length<3) return [];
  if(poly.length===3) return [[poly[0],poly[1],poly[2]]];
  // Determine winding via shoelace: Σ(x[j]-x[i])*(y[j]+y[i]) = -2 × signed_area.
  // For a CW polygon in SVG screen coords (y-down), signed_area > 0, so sum < 0.
  var sum=0;
  for(var i=0;i<poly.length;i++){var j=(i+1)%poly.length;sum+=(poly[j].x-poly[i].x)*(poly[j].y+poly[i].y);}
  var cw=sum<0; // CW in screen coords → sum < 0 (formula gives −2×signed_area)
  var verts=poly.slice(), tris=[], guard=poly.length*poly.length;
  while(verts.length>3&&guard-->0){
    var earFound=false;
    for(var i=0;i<verts.length;i++){
      var pv=verts[(i-1+verts.length)%verts.length], cv=verts[i], nv=verts[(i+1)%verts.length];
      // Cross product of edge pv→cv × edge cv→nv.
      // CW polygon: convex vertex has cross > 0 (right turn in screen y-down coords).
      // CCW polygon: convex vertex has cross < 0.
      var cross=(cv.x-pv.x)*(nv.y-cv.y)-(cv.y-pv.y)*(nv.x-cv.x);
      var convex=cw?(cross>-1e-10):(cross<1e-10);
      if(!convex) continue;
      // Ensure no other polygon vertex falls inside this ear triangle.
      var clean=true;
      for(var jj=0;jj<verts.length;jj++){
        if(jj===(i-1+verts.length)%verts.length||jj===i||jj===(i+1)%verts.length) continue;
        if(ptInTri(verts[jj],pv,cv,nv)){clean=false;break;}
      }
      if(clean){tris.push([pv,cv,nv]);verts.splice(i,1);earFound=true;break;}
    }
    if(!earFound) break; // degenerate or self-intersecting polygon, stop
  }
  if(verts.length===3) tris.push([verts[0],verts[1],verts[2]]);
  return tris;
}

// Merge multiple polygon boundary pieces (from triangulated clipping) into a
// single clean polygon (or a few polygons for disconnected regions) by dissolving
// shared triangle-seam edges. Only boundary edges (appearing once) survive;
// internal seam edges (shared by two adjacent pieces, appearing twice) are removed.
//
// This eliminates the visible white-stroke seams between triangle-clip fragments
// of the same cell while preserving all power-bisector boundaries correctly.
function mergePolygonPieces(pieces){
  if(!pieces||!pieces.length) return [];
  if(pieces.length===1) return [pieces[0]];
  // Round to 4 decimal places to handle floating-point from SH clipping
  function rnd(v){return Math.round(v*1e4)/1e4;}
  function vk(p){return rnd(p.x)+','+rnd(p.y);}
  // Undirected edge key (canonical order so a→b and b→a map to same key)
  function ek(a,b){var ka=vk(a),kb=vk(b);return ka<kb?ka+'|'+kb:kb+'|'+ka;}
  // Count undirected edge occurrences across all pieces
  var cnt={};
  for(var pi=0;pi<pieces.length;pi++){
    var poly=pieces[pi],nn=poly.length;
    for(var i=0;i<nn;i++){var k=ek(poly[i],poly[(i+1)%nn]);cnt[k]=(cnt[k]||0)+1;}
  }
  // Build directed next-vertex map for boundary edges (count===1 = not shared)
  // The direction is preserved from the piece that contains the edge.
  var nxt={};
  for(var pi=0;pi<pieces.length;pi++){
    var poly=pieces[pi],nn=poly.length;
    for(var i=0;i<nn;i++){
      var a=poly[i],b=poly[(i+1)%nn];
      if(cnt[ek(a,b)]===1) nxt[vk(a)]={v:b,key:vk(b)};
    }
  }
  // Trace connected boundary loops
  var vis={},result=[];
  var allKeys=Object.keys(nxt);
  for(var si=0;si<allKeys.length;si++){
    var start=allKeys[si];
    if(vis[start]) continue;
    var out=[],cur=start,guard=allKeys.length+10;
    while(!vis[cur]&&guard-->0){
      vis[cur]=true;
      var nx=nxt[cur]; if(!nx) break;
      out.push(nx.v); cur=nx.key;
    }
    if(out.length>=3) result.push(out);
  }
  // Fallback: if merging failed (degenerate geometry), return original pieces
  return result.length?result:pieces;
}

// ─── Pixel boundary tracing ───────────────────────────────────────────────────
// Trace the actual raster cell assignments into closed polygon loops.
// Returns an array (length n) of polygon arrays (one per cell).
// Each polygon list represents connected boundary loops for that cell.
// Result boundaries exactly represent the pixel counts — no deviation possible.
//
// Edge convention (CW winding in screen-Y-down coords, interior on the right):
//   top diff    → directed edge (px,py)→(px+1,py)
//   right diff  → directed edge (px+1,py)→(px+1,py+1)
//   bottom diff → directed edge (px+1,py+1)→(px,py+1)
//   left diff   → directed edge (px,py+1)→(px,py)
//
// Key insight: no two boundary edges of the same cell can share the same source
// grid point (a pixel can't be both in and not in the same cell), so a simple
// key→key string map is sufficient — no ambiguity at grid corners.
function traceAllCellBoundaries(n,cells,gs,mask){
  var edgeMaps=new Array(n);
  for(var i=0;i<n;i++) edgeMaps[i]={};
  var total=gs*gs;
  for(var idx=0;idx<total;idx++){
    if(!mask[idx]) continue;
    var ci=cells[idx], em=edgeMaps[ci];
    var px=idx%gs, py=idx/gs|0;
    if(py===0||!mask[idx-gs]||cells[idx-gs]!==ci)
      em[px+','+py]=(px+1)+','+py;
    if(px===gs-1||!mask[idx+1]||cells[idx+1]!==ci)
      em[(px+1)+','+py]=(px+1)+','+(py+1);
    if(py===gs-1||!mask[idx+gs]||cells[idx+gs]!==ci)
      em[(px+1)+','+(py+1)]=px+','+(py+1);
    if(px===0||!mask[idx-1]||cells[idx-1]!==ci)
      em[px+','+(py+1)]=px+','+py;
  }
  var result=new Array(n);
  for(var ci=0;ci<n;ci++){
    var em=edgeMaps[ci],visited={},polys=[],keys=Object.keys(em);
    for(var s=0;s<keys.length;s++){
      var start=keys[s]; if(visited[start]) continue;
      var loop=[],cur=start,guard=keys.length+10;
      while(em[cur]&&!visited[cur]&&guard-->0){
        visited[cur]=true;
        var sp=cur.split(',');
        loop.push({x:+sp[0],y:+sp[1]});
        cur=em[cur];
      }
      if(loop.length>=3) polys.push(loop);
    }
    result[ci]=polys;
  }
  return result;
}

// Chaikin curve smoothing — replaces each edge with two new points at 1/4 and 3/4.
// Converts staircase pixel outlines into smooth organic curves.
// Use 2–4 passes; output size doubles each pass so never use large values.
function chaikinSmooth(pts,passes){
  for(var p=0;p<passes;p++){
    var n=pts.length,next=[];
    for(var i=0;i<n;i++){
      var a=pts[i],b=pts[(i+1)%n];
      next.push({x:0.75*a.x+0.25*b.x, y:0.75*a.y+0.25*b.y});
      next.push({x:0.25*a.x+0.75*b.x, y:0.25*a.y+0.75*b.y});
    }
    pts=next;
  }
  return pts;
}

// Convex hull (Andrew's monotone chain). Returns the minimal convex polygon
// enclosing all input points. Used to make non-convex containers analytically
// tractable: powerCellPoly only works correctly on convex clipping polygons,
// and SVG clipPath handles the visual crop to the actual non-convex shape.
function convexHull(pts){
  if(pts.length<3) return pts;
  var p=pts.slice().sort(function(a,b){return a.x!==b.x?a.x-b.x:a.y-b.y;});
  var h=[];
  for(var i=0;i<p.length;i++){
    while(h.length>=2){var a=h[h.length-2],b=h[h.length-1],c=p[i];if((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)<=0)h.pop();else break;}
    h.push(p[i]);
  }
  var lo=h.length+1;
  for(var i=p.length-2;i>=0;i--){
    while(h.length>=lo){var a=h[h.length-2],b=h[h.length-1],c=p[i];if((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)<=0)h.pop();else break;}
    h.push(p[i]);
  }
  h.pop(); return h;
}

// Douglas-Peucker polyline simplification — collapses pixel staircase steps into
// straight line segments.  Power bisectors are mathematically straight, so the
// staircase pixel trace of a cell boundary closely approximates a straight line;
// D-P with a small epsilon collapses that staircase back into the straight segment.
function douglasPeucker(pts, epsilon){
  if(pts.length<3) return pts;
  function dpSeg(seg){
    if(seg.length<3) return seg;
    var f=seg[0],l=seg[seg.length-1];
    var dx=l.x-f.x,dy=l.y-f.y,len=Math.sqrt(dx*dx+dy*dy);
    var maxD=0,maxI=1;
    for(var i=1;i<seg.length-1;i++){
      var d=len<1e-10
        ?Math.sqrt((seg[i].x-f.x)*(seg[i].x-f.x)+(seg[i].y-f.y)*(seg[i].y-f.y))
        :Math.abs(dy*seg[i].x-dx*seg[i].y+l.x*f.y-l.y*f.x)/len;
      if(d>maxD){maxD=d;maxI=i;}
    }
    if(maxD>epsilon){
      var L=dpSeg(seg.slice(0,maxI+1)),R=dpSeg(seg.slice(maxI));
      return L.slice(0,L.length-1).concat(R);
    }
    return [f,l];
  }
  // Treat closed polygon as open chain p0→…→pN→p0, then drop the duplicated close
  var simplified=dpSeg(pts.concat([pts[0]]));
  if(simplified.length>1) simplified=simplified.slice(0,simplified.length-1);
  return simplified.length>=3?simplified:pts;
}

// ─── Analytical power diagram (kept for reference) ────────────────────────────
// Power diagram cell boundaries are mathematically straight lines (power bisectors).
// We compute them exactly via Sutherland-Hodgman half-plane clipping — zero jagging.

// Clip a polygon to the half-plane  a·x + b·y ≤ c  (Sutherland-Hodgman)
function clipHalfPlane(poly,a,b,c){
  var n=poly.length; if(!n) return [];
  var out=[];
  for(var i=0;i<n;i++){
    var p=poly[i], q=poly[(i+1)%n];
    var dp=a*p.x+b*p.y-c, dq=a*q.x+b*q.y-c;
    if(dp<=1e-9) out.push(p);
    if((dp<-1e-9&&dq>1e-9)||(dp>1e-9&&dq<-1e-9)){
      var t=dp/(dp-dq);
      out.push({x:p.x+t*(q.x-p.x), y:p.y+t*(q.y-p.y)});
    }
  }
  return out;
}

// Clip a subject polygon to a triangle using Sutherland-Hodgman on all 3 edges.
// The "inside" half-plane for each edge is determined by which side the opposite
// triangle vertex (the third point) falls on — works for any triangle winding.
function clipToTriangle(poly,A,B,C){
  function edgeClip(pts,p0,p1,inside){
    var a=p0.y-p1.y, b=p1.x-p0.x, c=a*p0.x+b*p0.y;
    // Flip the half-plane if 'inside' is on the wrong side
    if(a*inside.x+b*inside.y>c+1e-9){a=-a;b=-b;c=-c;}
    return clipHalfPlane(pts,a,b,c);
  }
  var r=poly.slice();
  r=edgeClip(r,A,B,C); if(r.length<3) return [];
  r=edgeClip(r,B,C,A); if(r.length<3) return [];
  r=edgeClip(r,C,A,B); if(r.length<3) return [];
  return r;
}

// Compute the exact power diagram cell for site si, clipped to containerPoly.
// For each other site j the boundary is:  2(xj-xi)·px + 2(yj-yi)·py ≤ xj²+yj²-wj - xi²-yi²+wi
function powerCellPoly(si,n,sX,sY,sW,containerPoly){
  var poly=containerPoly.slice();
  for(var j=0;j<n;j++){
    if(j===si||poly.length<3) continue;
    var a=2*(sX[j]-sX[si]), b=2*(sY[j]-sY[si]);
    var c=sX[j]*sX[j]+sY[j]*sY[j]-sW[j]-(sX[si]*sX[si]+sY[si]*sY[si]-sW[si]);
    poly=clipHalfPlane(poly,a,b,c);
  }
  return poly.length>=3 ? poly : [];
}

// Analytical container polygons — MUST match the corresponding mask functions exactly
// so that no cell polygon extends outside the drawn container boundary.

function circleContainerPoly(gs){
  // Matches makeCircleMask: cx=gs/2-0.5, cy=gs/2-0.5, r=gs/2-2
  var cx=gs/2-0.5, cy=gs/2-0.5, r=gs/2-2;
  var n=Math.max(180, gs*3), pts=[];
  for(var i=0;i<n;i++){var a=2*Math.PI*i/n; pts.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});}
  return pts;
}
function squareContainerPoly(gs){
  // Matches makeSquareMask exactly: pad=Math.max(2, gs*0.02|0)
  var p=Math.max(2, gs*0.02|0);
  return [{x:p,y:p},{x:gs-1-p,y:p},{x:gs-1-p,y:gs-1-p},{x:p,y:gs-1-p}];
}
function polyContainerPoly(gs,sides){
  // Matches makePolyMask: cx=gs/2-0.5, cy=gs/2-0.5, r=gs/2-2, vertex at -π/2
  var cx=gs/2-0.5, cy=gs/2-0.5, r=gs/2-2, pts=[];
  for(var i=0;i<sides;i++){var a=2*Math.PI*i/sides-Math.PI/2; pts.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});}
  return pts;
}
function triangleContainerPoly(gs){
  // Matches makeTriangleMask exactly: wide top (▽ shape), point at bottom.
  // At y=pad: x spans from pad to gs-pad. At bottom: x=gs/2, y=gs-pad-1.
  var pad=Math.max(1, gs*0.04|0);
  return [
    {x:pad,    y:pad},
    {x:gs-pad, y:pad},
    {x:gs/2,   y:gs-pad-1}
  ];
}
// For custom SVG shapes: return all closed sub-paths that the even-odd fill rule
// treats as FILLED (not holes). Sorted by area descending.
//
// Even-odd rule: a sub-path is a hole if it is nested inside an odd number of other
// sub-paths from the same SVG. We detect this by counting how many other sub-paths
// contain the centroid of each sub-path. Odd count → hole (excluded). Even count → fill.
//
// This ensures the container polygons match scanlineFill's even-odd mask exactly,
// preventing analytical cells from bleeding into SVG hole regions.
function svgContainerPolys(gs, svgData){
  var vb=svgData.viewBox, t=svgUniformTransform(gs,vb);
  var candidates=[];
  for(var i=0;i<svgData.paths.length;i++){
    var pp=pathToPolylines(parseSVGPath(svgData.paths[i]),t.offX,t.offY,t.scale,t.scale);
    for(var j=0;j<pp.length;j++){
      var poly=pp[j]; if(poly.length<3) continue;
      // Remove ALL closing duplicates. Paths with an explicit closing L + Z (e.g. polygon
      // SVG elements) produce two closing copies of the start point; remove them all.
      while(poly.length>3){
        var last=poly[poly.length-1];
        if(Math.abs(last.x-poly[0].x)<0.01&&Math.abs(last.y-poly[0].y)<0.01)
          poly=poly.slice(0,poly.length-1);
        else break;
      }
      if(poly.length<3) continue;
      var a=polyArea(poly);
      if(a>1) candidates.push({poly:poly, area:a}); // ignore sub-pixel slivers
    }
  }
  // Determine even-odd fill status: count how many other sub-paths contain this one's centroid.
  // Even count (0, 2, 4…) → filled region. Odd count (1, 3…) → hole (skip).
  var results=[];
  for(var i=0;i<candidates.length;i++){
    var ci=candidates[i], p=ci.poly;
    // Use centroid (average of vertices) as the test point
    var cx=0,cy=0;
    for(var k=0;k<p.length;k++){cx+=p[k].x;cy+=p[k].y;}
    cx/=p.length; cy/=p.length;
    var containCount=0;
    for(var j=0;j<candidates.length;j++){
      if(j!==i && pointInPoly(cx,cy,candidates[j].poly)) containCount++;
    }
    // Even-odd: even containment depth → this region is filled
    if(containCount%2===0) results.push(ci);
  }
  // Largest area first (primary region first)
  results.sort(function(a,b){return b.area-a.area;});
  return results.map(function(r){return r.poly;});
}

// ─── Tree helpers ────────────────────────────────────────────────────────────
function assignPaths(node,path){
  node._path=path.concat([node.name]);
  for(var i=0;i<node.children.length;i++) assignPaths(node.children[i],node._path);
}
function countNodes(node){
  var c=0;for(var i=0;i<node.children.length;i++)c+=1+countNodes(node.children[i]);return c;
}

// ═══ OPTIMISED CORE ══════════════════════════════════════════════════════════
// computeLevel: inlined Lloyd loop operating only on inside-pixels
//   - insideIdx[]  : flat pixel indices inside mask
//   - insX/insY[]  : precomputed (x,y) — avoids idx%gs and idx/gs in hot path
//   - sX/sY/sW[]   : Float64Array site coords — faster than {x,y,w} objects
//   - cells[]       : pre-allocated, reused across all Lloyd iterations

// containerPolys: array of polygons (one per disconnected sub-region of the container).
// Standard shapes pass a single-element array; custom SVGs may pass multiple.
function computeLevel(parentNode, parentMask, gs, iters, smooth, out, depth, onProg, total, doneRef, containerPolys) {
  var children=parentNode.children;
  if(!children||!children.length) return;
  var n=children.length;

  // ── 1. Build inside-pixel arrays ─────────────────────────────────────────
  var fullLen=gs*gs;
  var insideIdx=new Int32Array(fullLen); // will subarray later
  var m=0;
  for(var idx=0;idx<fullLen;idx++) if(parentMask[idx]) insideIdx[m++]=idx;
  if(m<n*4) return;
  insideIdx=insideIdx.subarray(0,m);

  // Precompute pixel coordinates — eliminates modulo/divide in hot loop
  var insX=new Uint16Array(m), insY=new Uint16Array(m);
  for(var k=0;k<m;k++){insX[k]=insideIdx[k]%gs; insY[k]=insideIdx[k]/gs|0;}

  // ── 2. Typed arrays for n children ───────────────────────────────────────
  var sX=new Float64Array(n), sY=new Float64Array(n), sW=new Float64Array(n);
  var fracs=new Float64Array(n);
  var tot=0; for(var i=0;i<n;i++) tot+=children[i].value;
  for(var i=0;i<n;i++) fracs[i]=Math.max(0,children[i].value)/tot;

  // Init sites: spread evenly over inside pixels + small jitter.
  // All weights start at 0 — no pre-adjustment by fraction.
  //
  // Why not pre-warm the weights from fracs[]?  With a log-ratio warm weight,
  // a small-fraction region (e.g. Africa at 4%) gets a highly negative starting
  // weight (≈ −4×m/n).  In a 120×120 grid the average inter-site distance is
  // only ~45 px, so a large-fraction neighbour's power radius exceeds that gap
  // and steals Africa's own site pixel from the very first iteration — giving
  // Africa 0 pixels before the boost code can help.
  //
  // Solution: start all sites at weight 0 (equal-area power diagram = regular
  // Voronoi).  The first WARMUP_ITERS iterations are pure-centroid Lloyd with
  // no weight updates, letting every site settle into a stable, well-separated
  // position.  Weight corrections only activate after that phase.
  // Build n evenly-spaced starting indices across inside pixels, then Fisher-Yates
  // shuffle them so each site gets a random spatial starting position on every run.
  // Without the shuffle, site 0 always starts top-left and site n-1 always starts
  // bottom-right — Lloyd converges them to the same layout every time.
  var startIdx=new Array(n);
  for(var i=0;i<n;i++) startIdx[i]=Math.min((i+.5)*m/n|0, m-1);
  for(var i=n-1;i>0;i--){var j=(Math.random()*(i+1))|0;var tmp=startIdx[i];startIdx[i]=startIdx[j];startIdx[j]=tmp;}
  for(var i=0;i<n;i++){
    sX[i]=insX[startIdx[i]]+(Math.random()-.5)*4;
    sY[i]=insY[startIdx[i]]+(Math.random()-.5)*4;
    sW[i]=0; // all sites start equal; centroid phase spreads them before weights activate
  }
  var WARMUP_ITERS=Math.max(1, Math.round(iters*0.25)); // first 25% = pure centroid

  // Accumulator buffers (reused each Lloyd step)
  var cntA=new Float64Array(n), cxA=new Float64Array(n), cyA=new Float64Array(n);

  // Pre-allocated cells array (reused across ALL Lloyd iterations)
  var cells=new Int32Array(fullLen); // -1 means unassigned; only inside pixels matter

  // ── 3. Lloyd iterations ───────────────────────────────────────────────────
  for(var iter=0;iter<iters;iter++){

    // Assign cells — only iterate inside pixels
    for(var k=0;k<m;k++){
      var px=insX[k],py=insY[k],best=0,bestD=1e18;
      for(var s=0;s<n;s++){
        var dx=px-sX[s],dy=py-sY[s],d=dx*dx+dy*dy-sW[s];
        if(d<bestD){bestD=d;best=s;}
      }
      cells[insideIdx[k]]=best;
    }

    // Lloyd step — accumulate centroid & area from inside pixels only
    cntA.fill(0); cxA.fill(0); cyA.fill(0);
    for(var k=0;k<m;k++){
      var s=cells[insideIdx[k]];
      cntA[s]++; cxA[s]+=insX[k]; cyA[s]+=insY[k];
    }
    // ── Centroid update (all phases) ───────────────────────────────────────
    // Phase 1 (iter < WARMUP_ITERS): pure centroid Lloyd, no weight changes.
    //   Sites spread into stable positions before area corrections begin.
    //   Every site gets roughly equal area → no site starved from the start.
    // Phase 2 (iter >= WARMUP_ITERS): centroid + log-ratio weight update.
    //   lrFactor anneals 0.20→0.05 over the weight-correction phase only.
    //
    // 0-pixel recovery (both phases):
    //   Smart relocation — try 8 candidates, keep the one furthest from all
    //   other sites.  In phase 2 also boost the weight so the site can compete.

    var inWeightPhase = (iter >= WARMUP_ITERS);
    // lrFactor counts only over the weight-correction phase
    var weightIter = iter - WARMUP_ITERS;
    var weightIters = iters - WARMUP_ITERS;
    var lrFactor = inWeightPhase ? (weightIters>1 ? 0.15*(1-weightIter/(weightIters-1))+0.05 : 0.05) : 0;
    var wClamp = 10*(m/n);

    for(var i=0;i<n;i++){
      if(cntA[i]>0){
        sX[i]=cxA[i]/cntA[i]; sY[i]=cyA[i]/cntA[i];
      } else {
        // Smart relocation: try 8 candidates, pick furthest from all other sites.
        var bestRi=((Math.random()*m)|0), bestScore=-1;
        for(var _a=0;_a<8;_a++){
          var _ri=((Math.random()*m)|0), _minD=1e18;
          for(var _j=0;_j<n;_j++){
            if(_j===i) continue;
            var _dx=insX[_ri]-sX[_j], _dy=insY[_ri]-sY[_j];
            var _d=_dx*_dx+_dy*_dy; if(_d<_minD) _minD=_d;
          }
          if(_minD>bestScore){bestScore=_minD;bestRi=_ri;}
        }
        sX[i]=insX[bestRi]; sY[i]=insY[bestRi];
        // In weight phase: boost weight so recovering site can compete next iter.
        if(inWeightPhase&&fracs[i]*m>=0.5)
          sW[i]=Math.min(sW[i]+(m/n)*lrFactor, wClamp);
        continue;
      }
      if(!inWeightPhase||fracs[i]*m<0.5) continue; // centroid-only phase, or sub-pixel target
      var actual=cntA[i]/m;
      var lr=Math.log(fracs[i]/actual);
      lr=Math.max(-1.0,Math.min(1.0,lr));
      sW[i]+=lr*(m/n)*lrFactor;
      if(sW[i]>wClamp) sW[i]=wClamp;
      if(sW[i]<-wClamp) sW[i]=-wClamp;
    }
  }

  // Final cell assignment
  for(var k=0;k<m;k++){
    var px=insX[k],py=insY[k],best=0,bestD=1e18;
    for(var s=0;s<n;s++){var dx=px-sX[s],dy=py-sY[s],d=dx*dx+dy*dy-sW[s];if(d<bestD){bestD=d;best=s;}}
    cells[insideIdx[k]]=best;
  }

  // ── 4. Accumulate pixel centroids & area counts ──────────────────────────
  var lbX=new Float64Array(n), lbY=new Float64Array(n), lbCnt=new Float64Array(n);
  for(var k=0;k<m;k++){
    var s=cells[insideIdx[k]], px=insX[k], py=insY[k];
    lbCnt[s]++; lbX[s]+=px; lbY[s]+=py;
  }

  // ── 5. Analytical power-diagram boundaries + area refinement + output ───────
  // Lloyd gives us converged (sX,sY,sW); we switch to exact power-bisector
  // geometry for display.  Two strategies based on container shape:
  //
  //   Convex container (circle, square, hexagon, octagon, triangle):
  //     powerCellPoly(i, ..., containerPoly) clips directly — fast, one pass.
  //
  //   Non-convex container (star, custom SVG):
  //     1. powerCellPoly clips bigBox → convex power cell
  //     2. earClipTriangulate decomposes non-convex container → triangles
  //     3. clipToTriangle intersects cell with each triangle (SH, exact)
  //     4. mergePolygonPieces dissolves triangle seam edges → clean poly
  //
  // After the initial boundaries, we run up to REFINE_ITERS extra weight-
  // correction passes using polyArea(analytical polygon) as feedback.
  // This closes the gap between what pixel counts say and what the user sees.

  var bigBox=[{x:0,y:0},{x:gs,y:0},{x:gs,y:gs},{x:0,y:gs}];
  var singleConvex=containerPolys&&containerPolys.length===1&&isConvexPoly(containerPolys[0]);

  // Always use a convex analytical container for powerCellPoly.
  // Non-convex SVG containers: take convex hull of all vertices so power cells
  // are always non-empty convex polygons. SVG clipPath in the renderer handles
  // visual crop to the actual shape. This also guarantees parent/child boundary
  // alignment: child receives a convex analytical cell → uses analytical too.
  var analyticalContainer;
  if(singleConvex){
    analyticalContainer=containerPolys[0];
  } else {
    var allHullPts=[];
    if(containerPolys&&containerPolys.length){
      for(var _pi=0;_pi<containerPolys.length;_pi++)
        for(var _vi=0;_vi<containerPolys[_pi].length;_vi++)
          allHullPts.push(containerPolys[_pi][_vi]);
    }
    analyticalContainer=convexHull(allHullPts.length>=3?allHullPts:bigBox);
  }

  function cellBnds(i){
    var cell=powerCellPoly(i,n,sX,sY,sW,analyticalContainer);
    return (cell&&cell.length>=3)?[cell]:[];
  }

  // Always compute analytical boundaries
  var analyticalBnds=new Array(n);
  for(var i=0;i<n;i++) analyticalBnds[i]=cellBnds(i);

  var REFINE_ITERS=20;
  for(var ref=0;ref<REFINE_ITERS;ref++){
    var aTotal=0, aAreas=new Float64Array(n);
    for(var i=0;i<n;i++){
      var bnd=analyticalBnds[i];
      for(var p=0;p<bnd.length;p++) aAreas[i]+=polyArea(bnd[p]);
      aTotal+=aAreas[i];
    }
    if(aTotal<1) break;
    var changed=false;
    for(var i=0;i<n;i++){
      if(fracs[i]*aTotal<0.5) continue;
      if(aAreas[i]<0.5){
        sW[i]=Math.min(sW[i]+(m/n)*0.12, 10*(m/n));
        changed=true; continue;
      }
      var aFrac=aAreas[i]/aTotal;
      var lr=Math.log(fracs[i]/aFrac);
      lr=Math.max(-0.8,Math.min(0.8,lr));
      if(Math.abs(lr)<0.002) continue;
      sW[i]+=lr*(m/n)*0.12;
      changed=true;
    }
    if(!changed) break;
    for(var i=0;i<n;i++) analyticalBnds[i]=cellBnds(i);
  }

  // Pixel boundaries — emergency fallback only
  var pixelBnds=null;
  function getPixelBnds(){ if(!pixelBnds) pixelBnds=traceAllCellBoundaries(n,cells,gs,parentMask); return pixelBnds; }

  for(var i=0;i<n;i++){
    var child=children[i],isLeaf=!child.children||!child.children.length;

    var boundaries=[];
    var cellContainerPolys=[];

    if(analyticalBnds[i]&&analyticalBnds[i].length){
      boundaries=analyticalBnds[i];
      cellContainerPolys=analyticalBnds[i]; // each cell is convex → child uses analytical automatically
    } else {
      // Emergency fallback: pixel-trace → D-P
      var raw=(getPixelBnds()[i])||[];
      if(raw.length){
        var dpEps=1.5;
        boundaries=raw.map(function(b){ return douglasPeucker(b,dpEps); });
        cellContainerPolys=boundaries;
      }
    }

    // Label position: pixel centroid → boundary centroid → site
    var labelX=sX[i], labelY=sY[i];
    if(lbCnt[i]>0){ labelX=lbX[i]/lbCnt[i]; labelY=lbY[i]/lbCnt[i]; }
    else if(boundaries.length>0){
      var _bx=0,_by=0,_bn=boundaries[0].length;
      for(var _bi=0;_bi<_bn;_bi++){_bx+=boundaries[0][_bi].x;_by+=boundaries[0][_bi].y;}
      if(_bn>0){labelX=_bx/_bn;labelY=_by/_bn;}
    }
    var label={x:labelX,y:labelY,
               radius:lbCnt[i]>0?Math.sqrt(lbCnt[i]/Math.PI):0,area:lbCnt[i]};

    if(boundaries.length>0){
      out.push({name:child.name,value:child.value,boundary:boundaries[0],boundaries:boundaries,
                isLeaf:isLeaf,depth:depth,color:child._color||'#888',label:label,
                path:child._path||[child.name]});
    }
    doneRef.v++; if(onProg) onProg(doneRef.v,total);

    if(!isLeaf&&boundaries.length>0){
      var childMask=new Uint8Array(fullLen);
      for(var k=0;k<m;k++) if(cells[insideIdx[k]]===i) childMask[insideIdx[k]]=1;
      computeLevel(child,childMask,gs,iters,smooth,out,depth+1,onProg,total,doneRef,cellContainerPolys);
    }
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
self.onmessage=function(e){
  var msg=e.data; if(msg.type!=='compute') return;
  var cfg=msg.config;
  try{
    var rows=parseCSV(cfg.csvText);
    if(rows.length<2){self.postMessage({type:'error',message:'CSV needs a header + at least one data row.'});return;}
    var tree=buildTree(rows,cfg.hierarchyCols,cfg.valueCol);
    if(!tree.children||!tree.children.length){self.postMessage({type:'error',message:'No valid data found — check column selections.'});return;}
    assignPaths(tree,[]);
    assignColors(tree,cfg.palette||'auto');

    var gs=cfg.gridSize||120, iters=cfg.iterations||22, smooth=cfg.smoothPasses||3;

    var shape=cfg.shape||'circle', mask, containerPolys, svgClipPolys=null;
    if(shape==='circle'){
      mask=makeCircleMask(gs);
      containerPolys=[circleContainerPoly(gs)];
    } else if(shape==='square'){
      mask=makeSquareMask(gs);
      containerPolys=[squareContainerPoly(gs)];
    } else if(shape==='triangle'){
      mask=makeTriangleMask(gs);
      containerPolys=[triangleContainerPoly(gs)];
    } else if(shape==='hexagon'){
      mask=makePolyMask(gs,6);
      containerPolys=[polyContainerPoly(gs,6)];
    } else if(shape==='octagon'){
      mask=makePolyMask(gs,8);
      containerPolys=[polyContainerPoly(gs,8)];
    } else if(shape==='custom'&&cfg.svgData){
      mask=makeSVGMask(gs,cfg.svgData);
      containerPolys=svgContainerPolys(gs,cfg.svgData);
      if(containerPolys.length){
        // Use the actual SVG shape polygons as the analytical container.
        // Non-convex shapes are triangulated inside computeLevel; after clipping,
        // mergePolygonPieces() dissolves triangle seams so cells render cleanly.
        // The same polygons serve as the SVG clipPath source in the renderer.
        svgClipPolys=containerPolys;
      } else {
        containerPolys=[circleContainerPoly(gs)]; // fallback
        svgClipPolys=null;
      }
    } else {
      mask=makeCircleMask(gs);
      containerPolys=[circleContainerPoly(gs)];
    }

    // containerShape tells the renderer to use an exact SVG primitive for the circle outline
    var containerShape=(shape==='circle')?{type:'circle',cx:gs/2-0.5,cy:gs/2-0.5,r:gs/2-2}:null;

    var total=countNodes(tree), out=[], doneRef={v:0};

    self.postMessage({type:'progress',pct:4,message:'Rasterising...'});

    computeLevel(tree,mask,gs,iters,smooth,out,0,
      function(done,tot){ self.postMessage({type:'progress',pct:4+Math.round(done/Math.max(tot,1)*93),message:'Computing '+done+'/'+tot}); },
      total,doneRef,containerPolys);

    self.postMessage({type:'progress',pct:98,message:'Rendering...'});
    // For custom SVG: display the actual shape polygons (svgClipPolys) as the container outline.
    // For all other shapes: display the analytical container polygons.
    var displayPolys=svgClipPolys||containerPolys;
    // containerBoundary = first/primary region (backwards compat); containerBoundaries = all regions
    // svgClipPolys: non-null only for custom SVG — renderer uses these to create a <clipPath>
    self.postMessage({type:'done',items:out,containerBoundary:displayPolys[0]||[],containerBoundaries:displayPolys,containerShape:containerShape,svgClipPolys:svgClipPolys,gridSize:gs,headers:rows[0]});
  }catch(err){
    self.postMessage({type:'error',message:'Worker error: '+(err.message||String(err))});
  }
};
