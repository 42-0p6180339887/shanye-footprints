import {CAMPUS,projectMapPoint,placeMapLabels} from './map-projection.mjs';
const NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={}){const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));return el;}
function shortName(activity){return (activity.location||activity.name).split(/\s*[/／]\s*/)[0].replace(/一日徒步|重装野营|野营|探路|拉练|清山/g,'').slice(0,14);}
export async function renderJourneyMap(activities,openActivity){
  const pins=document.getElementById('journey-pins'),legend=document.getElementById('journey-legend');if(!pins||!legend)return;
  const campus=projectMapPoint(CAMPUS.lat,CAMPUS.lon);document.getElementById('map-campus').setAttribute('transform',`translate(${campus.x} ${campus.y})`);
  let locations={};try{const response=await fetch(new URL('./data/activity-locations.json',import.meta.url));if(response.ok)locations=await response.json();}catch{}
  pins.replaceChildren();legend.replaceChildren();
  const positions=activities.flatMap((activity,index)=>{const location=locations[activity.id],point=location&&projectMapPoint(location.lat,location.lon);return point?[{...point,activity,index,location}]:[];});
  for(const marker of placeMapLabels(positions)){
    const {activity,index,location,x,y,anchorX,anchorY}=marker,number=String(index+1).padStart(2,'0');
    const link=svg('a',{href:`#activity=${activity.id}`,'aria-label':`${number} ${shortName(activity)}，查看活动`,'class':'journey-pin','data-activity':activity.id,'data-lat':location.lat,'data-lon':location.lon});
    const title=svg('title');title.textContent=`${activity.name} · 路线位置 ${location.lat.toFixed(4)}°N, ${location.lon.toFixed(4)}°E`;link.append(title);
    link.append(svg('path',{d:`M${anchorX} ${anchorY}L${x} ${y}`,'class':'pin-leader'}),svg('circle',{cx:anchorX,cy:anchorY,r:4,'class':'pin-anchor'}));
    const star=svg('path',{d:'M0-16 4.7-5.2 16-4.9 7.6 2.7 9.8 14 0 8.2-9.8 14-7.6 2.7-16-4.9-4.7-5.2Z',transform:`translate(${anchorX} ${anchorY})`,'class':'pin-star','aria-hidden':'true'});link.append(star);
    const group=svg('g',{transform:`translate(${x} ${y})`});
    group.append(svg('rect',{x:18,y:-19,width:132,height:32,rx:3,'class':'pin-halo'}));
    const label=svg('text',{x:49,y:2,'class':'pin-label'});label.textContent=shortName(activity);group.append(label);
    const num=svg('text',{x:26,y:2,'class':'pin-number'});num.textContent=number;group.append(num);
    link.append(group);link.addEventListener('click',event=>{event.preventDefault();openActivity(activity);});pins.append(link);
  }
  activities.forEach((activity,index)=>{const button=document.createElement('button');button.type='button';button.className='journey-legend-item';
    const n=document.createElement('span');n.textContent=String(index+1).padStart(2,'0');const name=document.createElement('span');name.textContent=shortName(activity);button.append(n,name);
    const located=positions.some(point=>point.activity.id===activity.id);button.title=`${activity.date}${located?' · 已按路线坐标定位':' · 暂缺可读取的路线坐标'}`;
    if(!located)button.classList.add('location-missing');button.addEventListener('click',()=>openActivity(activity));legend.append(button);
    const pin=pins.querySelector(`[data-activity="${activity.id}"]`);
    if(pin){
      const highlight=on=>{pin.classList.toggle('is-highlighted',on);button.classList.toggle('is-highlighted',on);};
      for(const target of [pin,button]){
        target.addEventListener('pointerenter',()=>highlight(true));target.addEventListener('pointerleave',()=>highlight(false));
        target.addEventListener('focus',()=>highlight(true));target.addEventListener('blur',()=>highlight(false));
      }
    }
  });
  document.getElementById('map-count').textContent=`最近 ${activities.length} 次活动`;
  document.getElementById('map-location-note').textContent=positions.length===activities.length?'位置来自路线文件':`已定位 ${positions.length} / ${activities.length}`;
  document.getElementById('map-period').textContent=activities[0]?.date?`截至 ${activities[0].date}`:'';
}
