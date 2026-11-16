'use strict';
// ═══ Voronoi Treemap Worker — exact power-diagram layout ════════════════════
// Every cell is an exact polygon: no pixel grid anywhere in the layout.
//
//  • Each level is a weighted (power) Voronoi diagram of the children's sites,
//    clipped to the parent's polygon(s) with Sutherland-Hodgman.
//  • For fixed sites, the weights are solved with a damped Newton method on the
//    exact polygon areas (semi-discrete optimal transport), so every cell's
//    drawn area matches its value to ~0.1% or better — even for cells that
//    are a tiny fraction of the whole.
//  • Sites then relax toward their cell centroids (Lloyd) for compact shapes
//    and the weights are re-solved; the final pass is always an exact solve.
//  • A child's container is its parent's exact polygon, so levels line up.
//  • Label anchors are poles of inaccessibility (the point deepest inside the
//    cell), so a label can never land outside the cell it belongs to.

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
  // Simplify before returning: raw Bezier-flattened outlines can carry hundreds of
  // near-collinear vertices, which balloons earClipTriangulate's triangle count for
  // non-convex containers (order n^2 triangles) and makes mergePolygonPieces prone to
  // dropping/mismatching triangle-seam fragments — producing intermittent gaps in the
  // rendered tiling that vary by run because site initialisation is randomised.
  // Douglas-Peucker collapses those near-straight runs while preserving true corners.
  return results.map(function(r){return douglasPeucker(r.poly, 0.15);});
}

// ─── Tree helpers ────────────────────────────────────────────────────────────
function assignPaths(node,path){
  node._path=path.concat([node.name]);
  for(var i=0;i<node.children.length;i++) assignPaths(node.children[i],node._path);
}
function countNodes(node){
  var c=0;for(var i=0;i<node.children.length;i++)c+=1+countNodes(node.children[i]);return c;
}

// ═══ EXACT POWER-DIAGRAM LAYOUT ══════════════════════════════════════════════
// Working polygon format: array of {x, y, t}. t is the id of the neighbouring
// site whose power bisector forms the edge from this vertex to the next
// (-1 = edge belongs to the container). Tags let us measure shared edge lengths
// for the Newton solve without any extra geometry.

function sArea(poly){
  var a=0, n=poly.length;
  for(var i=0;i<n;i++){ var p=poly[i], q=poly[i+1===n?0:i+1]; a+=p.x*q.y-q.x*p.y; }
  return a/2;
}

// Ear-clipping triangulation of a simple polygon (any winding). Returns triangles.
function earClip(poly){
  var verts=poly.map(function(p){return {x:p.x,y:p.y};});
  if(verts.length<3) return [];
  if(sArea(verts)<0) verts.reverse();
  function inTri(p,a,b,c){
    var e=1e-12;
    var d1=(p.x-b.x)*(a.y-b.y)-(a.x-b.x)*(p.y-b.y);
    var d2=(p.x-c.x)*(b.y-c.y)-(b.x-c.x)*(p.y-c.y);
    var d3=(p.x-a.x)*(c.y-a.y)-(c.x-a.x)*(p.y-a.y);
    return d1>=-e&&d2>=-e&&d3>=-e;
  }
  var tris=[], guard=verts.length*verts.length+10;
  while(verts.length>3&&guard-->0){
    var m=verts.length, found=false, i;
    for(i=0;i<m&&!found;i++){
      var ia=(i+m-1)%m, ic=(i+1)%m, a=verts[ia], b=verts[i], c=verts[ic];
      if((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)<=1e-12) continue;
      var clean=true;
      for(var j=0;j<m;j++){
        if(j===ia||j===i||j===ic) continue;
        var q=verts[j];
        if((q.x===a.x&&q.y===a.y)||(q.x===b.x&&q.y===b.y)||(q.x===c.x&&q.y===c.y)) continue;
        if(inTri(q,a,b,c)){ clean=false; break; }
      }
      if(clean){ tris.push([a,b,c]); verts.splice(i,1); found=true; }
    }
    if(!found){
      // Only degenerate (collinear / zero-area) corners left to remove.
      var dropped=false;
      for(i=0;i<m;i++){
        var pa=verts[(i+m-1)%m], pb=verts[i], pc=verts[(i+1)%m];
        if(Math.abs((pb.x-pa.x)*(pc.y-pb.y)-(pb.y-pa.y)*(pc.x-pb.x))<=1e-9){ verts.splice(i,1); dropped=true; break; }
      }
      if(!dropped) break;
    }
  }
  if(verts.length===3) tris.push([verts[0],verts[1],verts[2]]);
  return tris;
}

function isConvexPoly(poly){
  var n=poly.length, sign=0;
  if(n<4) return true;
  for(var i=0;i<n;i++){
    var a=poly[i], b=poly[(i+1)%n], c=poly[(i+2)%n];
    var cr=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    if(Math.abs(cr)<1e-9) continue;
    if(sign===0) sign=cr>0?1:-1; else if((cr>0?1:-1)!==sign) return false;
  }
  return true;
}

// A region is a list of CONVEX polygons with disjoint interiors, each vertex
// {x,y,t}. Clipping only ever happens against convex pieces, so a cell can never
// grow the degenerate "bridge" edges that clipping a concave polygon produces.
// `polys` may be arbitrary simple polygons (decomposed here) or, with
// decompose=false, pieces that are already convex.
function asRegion(polys,decompose){
  var region=[];
  function add(pts){
    pts=pts.map(function(p){return {x:p.x,y:p.y,t:-1};});
    if(pts.length<3) return;
    if(sArea(pts)<0) pts.reverse();
    if(Math.abs(sArea(pts))>1e-12) region.push(pts);
  }
  for(var i=0;i<polys.length;i++){
    if(!decompose||isConvexPoly(polys[i])) add(polys[i]);
    else earClip(polys[i]).forEach(add);
  }
  return region;
}
function regionArea(region){
  var a=0; for(var i=0;i<region.length;i++) a+=Math.abs(sArea(region[i])); return a;
}

// Keep the half-plane a*x + b*y <= c; new edges get `tag`.
function clipHalf(poly,a,b,c,tag){
  var n=poly.length, out=[], d=new Array(n), i;
  for(i=0;i<n;i++) d[i]=a*poly[i].x+b*poly[i].y-c;
  for(i=0;i<n;i++){
    var j=i+1===n?0:i+1, p=poly[i], q=poly[j], dp=d[i], dq=d[j];
    var pin=dp<=0, qin=dq<=0;
    if(pin) out.push(p);
    if(pin!==qin){
      var t=dp/(dp-dq);
      out.push({x:p.x+t*(q.x-p.x), y:p.y+t*(q.y-p.y), t:pin?tag:p.t});
    }
  }
  return out;
}

function maxDist(poly,sx,sy){
  var m=0;
  for(var i=0;i<poly.length;i++){
    var dx=poly[i].x-sx, dy=poly[i].y-sy, d=dx*dx+dy*dy;
    if(d>m) m=d;
  }
  return Math.sqrt(m);
}

// Exact power cell of site i inside the region (an array of polygons).
// `order[i]` lists the other sites by increasing distance; sites that cannot
// reach the current polygon are skipped with an O(1) test.
function powerCell(i,S,region,order){
  var sx=S.x[i], sy=S.y[i], wi=S.w[i], ord=order[i], pieces=[];
  var si2=sx*sx+sy*sy-wi;
  for(var r=0;r<region.length;r++){
    var poly=region[r], R=maxDist(poly,sx,sy);
    for(var k=0;k<ord.length&&poly;k++){
      var j=ord[k], dx=S.x[j]-sx, dy=S.y[j]-sy, d2=dx*dx+dy*dy, d=Math.sqrt(d2);
      if(2*R*d<=d2+wi-S.w[j]) continue;
      poly=clipHalf(poly,2*dx,2*dy,S.x[j]*S.x[j]+S.y[j]*S.y[j]-S.w[j]-si2,j);
      if(poly.length<3){ poly=null; break; }
      R=maxDist(poly,sx,sy);
    }
    if(poly) pieces.push(poly);
  }
  return pieces;
}

// Cells, exact areas, and shared-edge lengths K[i*n+j] for the current state.
function evalCells(n,S,region,order){
  var cells=new Array(n), areas=new Float64Array(n), K=new Float64Array(n*n);
  for(var i=0;i<n;i++){
    var pieces=powerCell(i,S,region,order), a=0;
    for(var p=0;p<pieces.length;p++){
      var poly=pieces[p], m=poly.length;
      a+=Math.abs(sArea(poly));
      for(var e=0;e<m;e++){
        var t=poly[e].t;
        if(t>=0){
          var q=poly[e+1===m?0:e+1], dx=q.x-poly[e].x, dy=q.y-poly[e].y;
          K[i*n+t]+=Math.sqrt(dx*dx+dy*dy);
        }
      }
    }
    cells[i]=pieces; areas[i]=a;
  }
  return {cells:cells, areas:areas, K:K};
}

// d(area_i)/d(w_j) = shared edge length / (2·distance): a graph Laplacian.
function buildLaplacian(n,S,K){
  var nbr=new Array(n), kv=new Array(n), diag=new Float64Array(n);
  for(var i=0;i<n;i++){
    var js=[], ks=[], dsum=0;
    for(var j=0;j<n;j++){
      if(j===i) continue;
      var len=0.5*(K[i*n+j]+K[j*n+i]);
      if(len<=0) continue;
      var dx=S.x[i]-S.x[j], dy=S.y[i]-S.y[j], dist=Math.sqrt(dx*dx+dy*dy);
      if(dist<1e-12) continue;
      var k=len/(2*dist);
      js.push(j); ks.push(k); dsum+=k;
    }
    nbr[i]=js; kv[i]=ks; diag[i]=dsum;
  }
  // If the adjacency graph is split (cells that never touch, e.g. across the gap
  // of a multi-part container), L has extra null directions and a plain Newton
  // step cannot move area between the parts. A small ridge (mu) keeps it solvable.
  var comp=new Int32Array(n).fill(-1), nc=0, mean=0, stack=[];
  for(var s0=0;s0<n;s0++){
    if(comp[s0]>=0) continue;
    comp[s0]=nc; stack.push(s0);
    while(stack.length){
      var u=stack.pop();
      for(var q=0;q<nbr[u].length;q++){ var v=nbr[u][q]; if(comp[v]<0){comp[v]=nc;stack.push(v);} }
    }
    nc++;
  }
  for(var m=0;m<n;m++) mean+=diag[m];
  mean/=n;
  var mu=nc>1?Math.max(1e-6,0.02*mean):0;
  for(var d=0;d<n;d++) diag[d]+=mu;
  return {nbr:nbr, kv:kv, diag:diag, mu:mu};
}

function lapMul(L,x,out){
  for(var i=0;i<x.length;i++){
    var js=L.nbr[i], ks=L.kv[i], s=L.mu*x[i];
    for(var k=0;k<js.length;k++) s+=ks[k]*(x[i]-x[js[k]]);
    out[i]=s;
  }
}

// Preconditioned conjugate gradient for L·x = rhs (L is PSD with constant nullspace).
function cgSolve(L,rhs){
  var n=rhs.length, x=new Float64Array(n), r=new Float64Array(n), z=new Float64Array(n);
  var p=new Float64Array(n), Ap=new Float64Array(n), mean=0, i;
  if(!(L.mu>0)){ for(i=0;i<n;i++) mean+=rhs[i]; mean/=n; }
  for(i=0;i<n;i++) r[i]=rhs[i]-mean;
  var r0=0; for(i=0;i<n;i++) r0+=r[i]*r[i];
  if(r0<1e-300) return x;
  var rz=0;
  for(i=0;i<n;i++){ z[i]=r[i]/(L.diag[i]>1e-300?L.diag[i]:1); p[i]=z[i]; rz+=r[i]*z[i]; }
  var maxIt=Math.min(4*n+20,600);
  for(var it=0;it<maxIt;it++){
    lapMul(L,p,Ap);
    var pAp=0; for(i=0;i<n;i++) pAp+=p[i]*Ap[i];
    if(!(pAp>1e-300)) break;
    var alpha=rz/pAp, rr=0;
    for(i=0;i<n;i++){ x[i]+=alpha*p[i]; r[i]-=alpha*Ap[i]; rr+=r[i]*r[i]; }
    if(rr<=1e-24*r0) break;
    var rzN=0;
    for(i=0;i<n;i++){ z[i]=r[i]/(L.diag[i]>1e-300?L.diag[i]:1); rzN+=r[i]*z[i]; }
    var beta=rzN/rz; rz=rzN;
    for(i=0;i<n;i++) p[i]=z[i]+beta*p[i];
  }
  if(!(L.mu>0)){
    var xm=0; for(i=0;i<n;i++) xm+=x[i]; xm/=n;
    for(i=0;i<n;i++) x[i]-=xm;
  }
  return x;
}

function relErrNorm(areas,T){
  var f=0;
  for(var i=0;i<areas.length;i++){ var e=(areas[i]-T[i])/T[i]; f+=e*e; }
  return f;
}
function maxRelErr(areas,T){
  var m=0;
  for(var i=0;i<areas.length;i++){ var e=Math.abs(areas[i]-T[i])/T[i]; if(e>m) m=e; }
  return m;
}

// Sites ordered by distance from each site; lets powerCell try the nearest first.
function computeOrder(n,S){
  var order=new Array(n);
  for(var a=0;a<n;a++){
    var idx=[], ax=S.x[a], ay=S.y[a];
    for(var b=0;b<n;b++) if(b!==a) idx.push(b);
    idx.sort(function(p,q){
      var dp=(S.x[p]-ax)*(S.x[p]-ax)+(S.y[p]-ay)*(S.y[p]-ay);
      var dq=(S.x[q]-ax)*(S.x[q]-ax)+(S.y[q]-ay)*(S.y[q]-ay);
      return dp-dq;
    });
    order[a]=Int32Array.from(idx);
  }
  return order;
}

function insideRegion(x,y,region){
  for(var i=0;i<region.length;i++) if(pointInPoly(x,y,region[i])) return true;
  return false;
}

// Damped Newton on the weights (Kitagawa–Mérigot–Thibert): steps are accepted
// only if no cell collapses and the area error decreases.
// Mutates S.w (and S.x/S.y only to rescue a site whose cell is empty).
// Returns the evaluation at the final weights.
function solveWeights(n,S,region,T,tol,maxIt){
  var order=computeOrder(n,S), ev=evalCells(n,S,region,order), i;
  for(var attempt=0;attempt<3;attempt++){
    var empty=[];
    for(i=0;i<n;i++) if(!(ev.areas[i]>0)) empty.push(i);
    if(!empty.length) break;
    S.w.fill(0);
    if(attempt>0) for(i=0;i<empty.length;i++){
      var pt=randomPointIn(region); S.x[empty[i]]=pt.x; S.y[empty[i]]=pt.y;
    }
    order=computeOrder(n,S); ev=evalCells(n,S,region,order);
  }
  for(var it=0;it<maxIt;it++){
    if(maxRelErr(ev.areas,T)<tol) break;
    var L=buildLaplacian(n,S,ev.K), rhs=new Float64Array(n);
    for(i=0;i<n;i++) rhs[i]=T[i]-ev.areas[i];
    var delta=cgSolve(L,rhs), f0=relErrNorm(ev.areas,T), alpha=1, accepted=false;
    var wOld=S.w.slice();
    // Disconnected cell graph: area is flat in the weights until a cell reaches
    // across the gap, and the useful step window can be narrow, so search finely.
    var disc=L.mu>0, ratio=disc?0.85:0.5, maxLs=disc?160:40;
    for(var ls=0;ls<maxLs;ls++){
      for(i=0;i<n;i++) S.w[i]=wOld[i]+alpha*delta[i];
      var evN=evalCells(n,S,region,order), ok=true;
      for(i=0;i<n;i++){
        if(!(evN.areas[i]>=0.5*Math.min(T[i],ev.areas[i]))){ ok=false; break; }
      }
      if(ok){
        var fN=relErrNorm(evN.areas,T);
        if(disc?fN<f0*(1-1e-6):fN<=(1-0.25*alpha)*f0){ ev=evN; accepted=true; break; }
      }
      alpha*=ratio;
    }
    if(!accepted){ S.w.set(wOld); break; }
  }
  return ev;
}

function centroidOf(pieces){
  var A=0, cx=0, cy=0;
  for(var p=0;p<pieces.length;p++){
    var poly=pieces[p], m=poly.length;
    for(var i=0;i<m;i++){
      var a=poly[i], b=poly[i+1===m?0:i+1], cr=a.x*b.y-b.x*a.y;
      A+=cr; cx+=(a.x+b.x)*cr; cy+=(a.y+b.y)*cr;
    }
  }
  if(Math.abs(A)<1e-18) return null;
  return {x:cx/(3*A), y:cy/(3*A)};
}

function randomPointIn(region){
  var tot=regionArea(region), r=Math.random()*tot, piece=region[region.length-1], i;
  for(i=0;i<region.length;i++){
    var ar=Math.abs(sArea(region[i]));
    if(r<=ar){ piece=region[i]; break; }
    r-=ar;
  }
  // Convex piece: pick a fan triangle by area, then a uniform point inside it.
  var m=piece.length, pa=piece[0], areas=[], sum=0;
  for(i=1;i<m-1;i++){
    var t=Math.abs((piece[i].x-pa.x)*(piece[i+1].y-pa.y)-(piece[i+1].x-pa.x)*(piece[i].y-pa.y))/2;
    areas.push(t); sum+=t;
  }
  var pick=Math.random()*sum, k=0;
  while(k<areas.length-1&&pick>areas[k]){ pick-=areas[k]; k++; }
  var pb=piece[k+1], pc=piece[k+2], u=Math.random(), v=Math.random();
  if(u+v>1){ u=1-u; v=1-v; }
  return {x:pa.x+u*(pb.x-pa.x)+v*(pc.x-pa.x), y:pa.y+u*(pb.y-pa.y)+v*(pc.y-pa.y)};
}

// Dissolve the seams between a cell's convex pieces into clean outline loops.
// Shared seam edges appear twice (once per piece, opposite directions) and
// cancel; what remains is the cell's true boundary.
function mergePieces(pieces){
  var polys=pieces.map(plainPoly).filter(function(p){return p.length>=3;});
  if(polys.length<=1) return polys;
  var Q=1e6;
  function key(p){ return Math.round(p.x*Q)+','+Math.round(p.y*Q); }
  var count={}, edges=[], i, j;
  for(i=0;i<polys.length;i++){
    var poly=polys[i], m=poly.length;
    for(j=0;j<m;j++){
      var p=poly[j], q=poly[(j+1)%m], kp=key(p), kq=key(q);
      if(kp===kq) continue;
      var ek=kp<kq?kp+'|'+kq:kq+'|'+kp;
      count[ek]=(count[ek]||0)+1;
      edges.push({p:p,kp:kp,kq:kq,ek:ek,used:false});
    }
  }
  var from={};
  for(i=0;i<edges.length;i++){
    if(count[edges[i].ek]!==1) continue;
    (from[edges[i].kp]=from[edges[i].kp]||[]).push(edges[i]);
  }
  var loops=[];
  for(i=0;i<edges.length;i++){
    var e0=edges[i];
    if(count[e0.ek]!==1||e0.used) continue;
    var loop=[], e=e0, guard=edges.length+5;
    while(e&&!e.used&&guard-->0){
      e.used=true; loop.push({x:e.p.x,y:e.p.y});
      var nxt=from[e.kq], nextE=null;
      for(j=0;nxt&&j<nxt.length;j++) if(!nxt[j].used){ nextE=nxt[j]; break; }
      e=nextE;
    }
    if(loop.length>=3) loops.push(plainPoly(loop));
  }
  return loops.length?loops:polys;
}

// Lay out n children inside `region`. Returns, per child, an array of plain
// {x,y} polygons whose exact areas are proportional to the child values.
function layoutChildren(children,region,iters){
  var n=children.length, A=regionArea(region), tot=0, i;
  for(i=0;i<n;i++) tot+=Math.max(0,children[i].value);
  if(n===1) return [region.map(plainPoly)];

  var T=new Float64Array(n);
  for(i=0;i<n;i++) T[i]=Math.max(1e-12*A, A*Math.max(0,children[i].value)/tot);

  var S={x:new Float64Array(n), y:new Float64Array(n), w:new Float64Array(n)};
  for(i=0;i<n;i++){ var pt=randomPointIn(region); S.x[i]=pt.x; S.y[i]=pt.y; }

  // Move each site to its cell's centroid. A centroid can fall outside a
  // non-convex or multi-part container (in a notch, or the gap between parts),
  // which would strand the site; use the cell's deepest interior point instead.
  function moveToCentroids(cells){
    var disp=0;
    for(var a=0;a<n;a++){
      if(!cells[a].length) continue;
      var c=centroidOf(cells[a]);
      if(!c||!insideRegion(c.x,c.y,region)){
        var outline=mergePieces(cells[a]), cellA=0;
        for(var q=0;q<outline.length;q++) cellA+=Math.abs(sArea(outline[q]));
        var pole=poleOfInaccessibility(outline,Math.max(1e-6,0.01*Math.sqrt(cellA)));
        c={x:pole.x,y:pole.y};
      }
      var dx=c.x-S.x[a], dy=c.y-S.y[a];
      disp=Math.max(disp,Math.sqrt(dx*dx+dy*dy));
      S.x[a]=c.x; S.y[a]=c.y;
    }
    return disp;
  }

  // Spread the sites out with plain (equal-weight) Lloyd before sizing them.
  for(var wu=0;wu<4;wu++) moveToCentroids(evalCells(n,S,region,computeOrder(n,S)).cells);

  var scale=Math.sqrt(A), ev;
  for(var it=0;it<iters;it++){
    ev=solveWeights(n,S,region,T,1e-3,25);
    if(moveToCentroids(ev.cells)<1e-4*scale) break;
  }
  ev=solveWeights(n,S,region,T,1e-6,60);

  var out=new Array(n);
  for(i=0;i<n;i++){
    out[i]=ev.cells[i].map(plainPoly).filter(function(p){return p.length>=3&&Math.abs(sArea(p))>1e-12*A;});
  }
  return out;
}

// Drop tags and consecutive duplicate vertices.
function plainPoly(poly){
  var out=[];
  for(var i=0;i<poly.length;i++){
    var p=poly[i], q=out[out.length-1];
    if(q&&Math.abs(p.x-q.x)<1e-9&&Math.abs(p.y-q.y)<1e-9) continue;
    out.push({x:p.x,y:p.y});
  }
  while(out.length>1&&Math.abs(out[0].x-out[out.length-1].x)<1e-9&&Math.abs(out[0].y-out[out.length-1].y)<1e-9) out.pop();
  return out;
}

// ─── Label anchor: pole of inaccessibility ───────────────────────────────────
// The point inside the cell farthest from every edge (polylabel). Guaranteed to
// be inside the cell, unlike a centroid, and its distance to the boundary is
// the radius of the largest circle that fits.
function distToPolys(x,y,polys){
  var inside=false, best=Infinity;
  for(var k=0;k<polys.length;k++){
    var poly=polys[k], n=poly.length;
    for(var i=0,j=n-1;i<n;j=i++){
      var a=poly[i], b=poly[j];
      if(((a.y>y)!==(b.y>y))&&(x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)) inside=!inside;
      var dx=b.x-a.x, dy=b.y-a.y, len2=dx*dx+dy*dy;
      var t=len2>0?Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/len2)):0;
      var ex=x-(a.x+t*dx), ey=y-(a.y+t*dy), d=ex*ex+ey*ey;
      if(d<best) best=d;
    }
  }
  best=Math.sqrt(best);
  return inside?best:-best;
}

function poleOfInaccessibility(polys,precision){
  var minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,i,j;
  for(i=0;i<polys.length;i++) for(j=0;j<polys[i].length;j++){
    var p=polys[i][j];
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x; if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
  }
  var w=maxX-minX, h=maxY-minY, cs=Math.min(w,h);
  function mk(x,y,hh){ var d=distToPolys(x,y,polys); return {x:x,y:y,h:hh,d:d,max:d+hh*Math.SQRT2}; }
  if(cs<=0) return {x:minX,y:minY,d:0};
  var half=cs/2, queue=[];
  for(var x=minX;x<maxX;x+=cs) for(var y=minY;y<maxY;y+=cs) queue.push(mk(x+half,y+half,half));
  var cen=centroidOf(polys);
  var best=cen?mk(cen.x,cen.y,0):mk(minX+w/2,minY+h/2,0);
  var mid=mk(minX+w/2,minY+h/2,0);
  if(mid.d>best.d) best=mid;
  var guard=0;
  while(queue.length&&guard++<4000){
    var bi=0;
    for(i=1;i<queue.length;i++) if(queue[i].max>queue[bi].max) bi=i;
    var c=queue[bi]; queue[bi]=queue[queue.length-1]; queue.pop();
    if(c.d>best.d) best=c;
    if(c.max-best.d<=precision) continue;
    var hh=c.h/2;
    queue.push(mk(c.x-hh,c.y-hh,hh), mk(c.x+hh,c.y-hh,hh), mk(c.x-hh,c.y+hh,hh), mk(c.x+hh,c.y+hh,hh));
  }
  return best;
}

function computeLabel(pieces){
  var area=0; for(var i=0;i<pieces.length;i++) area+=Math.abs(sArea(pieces[i]));
  var pole=poleOfInaccessibility(pieces,Math.max(1e-6,0.004*Math.sqrt(area)));
  return {x:pole.x, y:pole.y, radius:Math.sqrt(area/Math.PI), inscribed:Math.max(0,pole.d), area:area};
}

// ─── Recursive level builder ─────────────────────────────────────────────────
function computeLevel(node,region,iters,out,depth,onProg,total,doneRef){
  var children=node.children;
  if(!children||!children.length) return;
  var cells=layoutChildren(children,region,iters);
  for(var i=0;i<children.length;i++){
    var child=children[i], pieces=cells[i], isLeaf=!child.children||!child.children.length;
    doneRef.v++; if(onProg) onProg(doneRef.v,total);
    if(!pieces||!pieces.length) continue;
    var loops=mergePieces(pieces), biggest=loops[0], bigA=Math.abs(sArea(loops[0]));
    for(var k=1;k<loops.length;k++){ var a=Math.abs(sArea(loops[k])); if(a>bigA){bigA=a;biggest=loops[k];} }
    out.push({name:child.name, value:child.value, boundary:biggest, boundaries:loops,
              isLeaf:isLeaf, depth:depth, color:child._color||'#888', label:computeLabel(loops),
              path:child._path||[child.name]});
    if(!isLeaf) computeLevel(child,asRegion(pieces,false),iters,out,depth+1,onProg,total,doneRef);
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

    var gs=cfg.gridSize||120, iters=Math.max(8,Math.min(cfg.iterations||40,80));

    var shape=cfg.shape||'circle', containerPolys, svgClipPolys=null;
    if(shape==='circle'){
      containerPolys=[circleContainerPoly(gs)];
    } else if(shape==='square'){
      containerPolys=[squareContainerPoly(gs)];
    } else if(shape==='triangle'){
      containerPolys=[triangleContainerPoly(gs)];
    } else if(shape==='hexagon'){
      containerPolys=[polyContainerPoly(gs,6)];
    } else if(shape==='octagon'){
      containerPolys=[polyContainerPoly(gs,8)];
    } else if(shape==='custom'&&cfg.svgData){
      containerPolys=svgContainerPolys(gs,cfg.svgData);
      if(containerPolys.length){
        svgClipPolys=containerPolys;
      } else {
        containerPolys=[circleContainerPoly(gs)];
      }
    } else {
      containerPolys=[circleContainerPoly(gs)];
    }

    var region=asRegion(containerPolys,true);
    if(!region.length){self.postMessage({type:'error',message:'The container shape has no usable area.'});return;}

    // containerShape tells the renderer to use an exact SVG primitive for the circle outline
    var containerShape=(shape==='circle')?{type:'circle',cx:gs/2-0.5,cy:gs/2-0.5,r:gs/2-2}:null;

    var total=countNodes(tree), out=[], doneRef={v:0};
    self.postMessage({type:'progress',pct:4,message:'Laying out...'});
    computeLevel(tree,region,iters,out,0,
      function(done,tot){ self.postMessage({type:'progress',pct:4+Math.round(done/Math.max(tot,1)*93),message:'Computing '+done+'/'+tot}); },
      total,doneRef);

    self.postMessage({type:'progress',pct:98,message:'Rendering...'});
    var displayPolys=svgClipPolys||containerPolys;
    self.postMessage({type:'done',items:out,containerBoundary:displayPolys[0]||[],containerBoundaries:displayPolys,containerShape:containerShape,svgClipPolys:svgClipPolys,gridSize:gs,headers:rows[0]});
  }catch(err){
    self.postMessage({type:'error',message:'Worker error: '+(err.message||String(err))});
  }
};
