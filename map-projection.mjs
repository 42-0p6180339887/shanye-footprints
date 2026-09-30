export const MAP_BOUNDS = {west:114.35,south:38.95,east:117.75,north:40.65};
export const CAMPUS = {lat:40,lon:116.326667};
export function projectMapPoint(lat,lon,bounds=MAP_BOUNDS,width=1200,height=780){
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  if(lat<bounds.south||lat>bounds.north||lon<bounds.west||lon>bounds.east) return null;
  return {x:(lon-bounds.west)/(bounds.east-bounds.west)*width,y:(bounds.north-lat)/(bounds.north-bounds.south)*height};
}
// Move overlapping labels, while retaining a dot and leader at the true coordinate.
export function placeMapLabels(points){
  const placed=[];
  for(const point of points){
    let best={x:point.x,y:point.y}, bestScore=Infinity;
    for(const radius of [0,50,85,120,160,205,250]) for(let angle=0;angle<Math.PI*2;angle+=Math.PI/4){
      const candidate={x:point.x+radius*Math.cos(angle),y:point.y+radius*Math.sin(angle)};
      if(candidate.x<24||candidate.x>1050||candidate.y<175||candidate.y>730)continue;
      const collisions=placed.reduce((n,p)=>n+(Math.abs(p.x-candidate.x)<150&&Math.abs(p.y-candidate.y)<49?1:0),0);
      const score=collisions*10000+radius;
      if(score<bestScore){best=candidate;bestScore=score;}
    }
    placed.push({...point,...best,anchorX:point.x,anchorY:point.y});
  }
  return placed;
}
