/*! hyrox-plan shared engine — core.js
 * Single localStorage root key 'hx:v3'. All pages include via <script src="assets/core.js">.
 * Engine logic (date/util, autoregulation, dynamic energy, schedule reflow, daily tracker,
 * CSV/JSON export) is PORTED VERBATIM from journey.html — same math, same thresholds.
 * Only the data layer is rewritten so the ported engine reads/writes hx:v3 sub-objects
 * instead of the legacy keys journeyDaily:v1 / journeyLoad:v1 / journeyDyn:v1 / journeyTrackV1.
 *
 * Unified shape (hx:v3):
 *   { profile:{age,cm,targetKg,rateKgWk,floorKcal,protPerKg},
 *     weights:{ "YYYY-MM-DD":{kg,bf} },
 *     days:   { "YYYY-MM-DD":{done,note} },
 *     load:   { "YYYY-MM-DD":{type,tier,rpe,dur,act} },
 *     meals:  [ {d,kcal,protein,social,note} ],
 *     journal:[ {d,text,page} ],
 *     settings:{ start, phase, hyrox:{startISO,curPace,tgtPace,racePace,days} } }
 *
 * SAFETY RED LINES (kept verbatim, unchanged):
 *   - per-day floor >= 1450 kcal (dynProfile.floorKcal default + dynWeekEnergy clamp)
 *   - protein floor 1.8 * targetKg (dynProfile.protPerKg default + protTarget)
 *   - weekly rate cap ~0.5 kg (<= 0.7%/wk) (dynProfile.rateKgWk default)
 */
(function(){
  'use strict';
  var HX = (window.HX = window.HX || {});
  var ROOT = 'hx:v3', MIG = 'hx:migrated';

  /* ===================== helpers (merged dupes arP/arISO/arPar/arAddD) ===================== */
  function dpad(n){return (n<10?'0':'')+n;}
  function diso(d){return d.getFullYear()+'-'+dpad(d.getMonth()+1)+'-'+dpad(d.getDate());}
  function dmd(d){return (d.getMonth()+1)+'/'+d.getDate();}
  function dParse(s){var p=(s||'').split('-');return new Date(+p[0],+p[1]-1,+p[2]);}
  function dMon(d){var x=new Date(d);var wd=(x.getDay()+6)%7;x.setDate(x.getDate()-wd);x.setHours(0,0,0,0);return x;}
  function dAdd(d,n){var x=new Date(d);x.setDate(x.getDate()+n);return x;}
  function dEsc(s){return (''+(s==null?'':s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function dToast(m){var el=document.getElementById('toast');if(!el)return;el.textContent=m;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},1800);}
  function dDl(name,text,mime){var b=new Blob([text],{type:(mime||'text/plain')+';charset=utf-8'});var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(u);a.remove();},120);}
  function dCc(v){v=(v==null?'':''+v);return '"'+v.replace(/"/g,'""')+'"';}
  function dIsRest(t){return /休|恢复/.test(t||'');}
  // legacy aliases (autoregulation block used arP/arISO/arPar/arAddD — now merged into the above)
  var arP=dpad, arISO=diso, arPar=dParse, arAddD=dAdd;

  /* ===================== store (single root key 'hx:v3') ===================== */
  function _read(){try{return JSON.parse(localStorage.getItem(ROOT)||'{}')||{};}catch(e){return {};}}
  function _normalize(d){
    d=d||{};
    d.profile=d.profile||{};
    d.weights=d.weights||{};
    d.days=d.days||{};
    d.load=d.load||{};
    d.meals=Array.isArray(d.meals)?d.meals:[];
    d.journal=Array.isArray(d.journal)?d.journal:[];
    d.settings=d.settings||{};
    return d;
  }
  function getStore(){return _normalize(_read());}
  function setStore(d){try{localStorage.setItem(ROOT,JSON.stringify(_normalize(d)));}catch(e){}}

  // in-memory live state + composite daily view
  var HXS = getStore();
  var DS = {};        // === settings view (DS.start / DS.phase / DS.offset) ===
  var DENT = {};      // === composite daily view {ISO:{done,w,bf,note}} rebuilt from hx.days+hx.weights ===
  var DPLAN = null;   // active plan for daily tracker (defaults to built-in PDATA)
  var DREFLOW = true; // whether daily render applies schedule reflow overlay

  function rebuildDENT(){
    DENT = {};
    var dy=HXS.days, w=HXS.weights, k;
    for(k in dy){ if(!DENT[k])DENT[k]={}; var e=dy[k]||{}; if(e.done!=null)DENT[k].done=e.done; if(e.note!=null)DENT[k].note=e.note; }
    for(k in w){ if(!DENT[k])DENT[k]={}; var g=w[k]||{}; if(g.kg!=null&&g.kg!=='')DENT[k].w=g.kg; if(g.bf!=null&&g.bf!=='')DENT[k].bf=g.bf; }
  }
  function save(){ setStore(HXS); }
  function dLoad(){ HXS=getStore(); DS=HXS.settings; rebuildDENT(); }
  function dSaveS(){ save(); }
  function dSaveE(){ save(); rebuildDENT(); }
  // route a daily-tracker field write to the correct hx sub-object (weight -> weights, else -> days)
  function dSetField(d,k,val){
    if(k==='w'){ HXS.weights[d]=HXS.weights[d]||{}; HXS.weights[d].kg=val; }
    else if(k==='bf'){ HXS.weights[d]=HXS.weights[d]||{}; HXS.weights[d].bf=val; }
    else { HXS.days[d]=HXS.days[d]||{}; HXS.days[d][k]=val; }
    save(); rebuildDENT();
  }

  /* ===================== migration (additive, run once, legacy keys preserved) ===================== */
  function _rdKey(k){try{return JSON.parse(localStorage.getItem(k)||'null');}catch(e){return null;}}
  function _mergeJournal(hx,src,page){
    if(!src)return;
    var arr = Array.isArray(src) ? src
            : (Array.isArray(src.journal) ? src.journal
            : (Array.isArray(src.entries) ? src.entries : null));
    if(!arr)return;
    arr.forEach(function(it){
      if(it==null)return;
      var d=it.d||it.date||it.day||'';
      var text=it.text||it.note||it.log||(typeof it==='string'?it:'');
      hx.journal.push({d:d,text:text,page:it.page||page});
    });
  }
  function _mergePhase2(hx,src){
    if(!src||typeof src!=='object')return;
    var wsrc = (src.weights&&typeof src.weights==='object') ? src.weights : null;
    if(!wsrc){
      var iso=/^\d{4}-\d{2}-\d{2}$/, any=false, tmp={};
      for(var k in src){ if(iso.test(k)&&src[k]&&typeof src[k]==='object'&&(src[k].w!=null||src[k].bf!=null||src[k].kg!=null)){tmp[k]=src[k];any=true;} }
      if(any)wsrc=tmp;
    }
    if(wsrc){
      for(var wk in wsrc){ var e=wsrc[wk]||{}, kg=(e.kg!=null?e.kg:e.w);
        hx.weights[wk]=hx.weights[wk]||{};
        if(kg!=null&&kg!==''&&hx.weights[wk].kg==null)hx.weights[wk].kg=kg;
        if(e.bf!=null&&e.bf!==''&&hx.weights[wk].bf==null)hx.weights[wk].bf=e.bf;
      }
    }
    if(Array.isArray(src.journal))_mergeJournal(hx,src.journal,'phase2');
  }
  function migrate(){
    if(localStorage.getItem(MIG))return false;
    var hx=getStore(), k;
    // journeyDaily:v1 {ISO:{done,w,bf,note}} -> days + weights
    var jd=_rdKey('journeyDaily:v1');
    if(jd&&typeof jd==='object'){
      for(k in jd){ var e=jd[k]||{};
        hx.days[k]=hx.days[k]||{};
        if(e.done!=null&&hx.days[k].done==null)hx.days[k].done=e.done;
        if(e.note!=null&&hx.days[k].note==null)hx.days[k].note=e.note;
        if((e.w!=null&&e.w!=='')||(e.bf!=null&&e.bf!=='')){
          hx.weights[k]=hx.weights[k]||{};
          if(e.w!=null&&e.w!==''&&hx.weights[k].kg==null)hx.weights[k].kg=e.w;
          if(e.bf!=null&&e.bf!==''&&hx.weights[k].bf==null)hx.weights[k].bf=e.bf;
        }
      }
    }
    // journeyLoad:v1 -> load
    var jl=_rdKey('journeyLoad:v1');
    if(jl&&typeof jl==='object'){ for(k in jl){ if(hx.load[k]==null)hx.load[k]=jl[k]; } }
    // journeyDyn:v1 {profile,meals} -> profile + meals
    var jdyn=_rdKey('journeyDyn:v1');
    if(jdyn&&typeof jdyn==='object'){
      if(jdyn.profile&&typeof jdyn.profile==='object'){ for(var pk in jdyn.profile){ if(hx.profile[pk]==null)hx.profile[pk]=jdyn.profile[pk]; } }
      if(Array.isArray(jdyn.meals))hx.meals=hx.meals.concat(jdyn.meals);
    }
    // journeyTrackV1 {w,bf} -> latest weights (today if no slot yet)
    var jt=_rdKey('journeyTrackV1');
    if(jt&&typeof jt==='object'&&((jt.w!=null&&jt.w!=='')||(jt.bf!=null&&jt.bf!==''))){
      var td=diso(new Date());
      hx.weights[td]=hx.weights[td]||{};
      if(jt.w!=null&&jt.w!==''&&hx.weights[td].kg==null)hx.weights[td].kg=jt.w;
      if(jt.bf!=null&&jt.bf!==''&&hx.weights[td].bf==null)hx.weights[td].bf=jt.bf;
    }
    // journeyDailySettings:v1 -> settings
    var js=_rdKey('journeyDailySettings:v1');
    if(js&&typeof js==='object'){ for(var sk in js){ if(hx.settings[sk]==null)hx.settings[sk]=js[sk]; } }
    // hyroxPlanV3 -> settings.hyrox
    var hp=_rdKey('hyroxPlanV3');
    if(hp&&typeof hp==='object'){ hx.settings.hyrox=hx.settings.hyrox||{}; for(var hk in hp){ if(hx.settings.hyrox[hk]==null)hx.settings.hyrox[hk]=hp[hk]; } }
    // hyroxLogV2 (+:journal) -> journal
    _mergeJournal(hx,_rdKey('hyroxLogV2'),'hyrox');
    _mergeJournal(hx,_rdKey('hyroxLogV2:journal'),'hyrox');
    // hyroxPhase2V2 (+:journal) -> weights / journal
    _mergePhase2(hx,_rdKey('hyroxPhase2V2'));
    _mergeJournal(hx,_rdKey('hyroxPhase2V2:journal'),'phase2');
    setStore(hx);
    try{localStorage.setItem(MIG,'1');}catch(e){}
    return true;
  }

  /* ===================== daily plan data (P1–P4, verbatim from journey.html) ===================== */
  var PDATA = [{"key": "p1", "name": "P1 · 启动燃脂", "wr": "74→65kg", "days": [{"d": "周一", "tag": "力量", "t": "力量A · 髋铰链下肢日(地基)", "x": "热身: 5min动态(髋绕环/猫驼/世界最伟大拉伸)+ prehab激活(臀桥2×15、蚌式2×15/侧、胫前提拉2×20、VMO靠墙静蹲30s×2)+ 空杆铰链练习。主课: 罗马尼亚硬拉3×8@RPE7 → 高脚杯深蹲(控深度至大腿约平行)3×10@RPE7 → 后脚抬高分腿蹲(扶持)2×8/侧@RPE6 → 抗伸展死虫3×10 + 侧桥3×30s/侧。护膝护腰: 硬拉全程脊柱中立、髋主导不塌腰;深蹲膝盖跟脚尖不内扣、深度以无痛为限;负重绝不做屈曲+旋转。EA/营养: 训练日吃够(EA≥40–45×FFM+当日消耗),练后30–60min补乳清/蛋+碳水;全天蛋白约165–178g、脂肪≥1.0g/kg、练日不造缺口。"}, {"d": "周二", "tag": "跑步", "t": "跑步Z2 · 低冲击燃脂引擎", "x": "热身: 快走渐进3–5min + 动态拉伸(腿前后摆/弓步走)+ 臀中肌、胫前激活。主课: Zone2匀速跑40–50min(配速约8:30–9:00/km、心率守低区、能完整说话),结束静态拉伸髋屈肌/腘绳/小腿。护膝护腰: 跑量温和加(周增<10%)、落地中足、步频偏高减冲击;膝有任何刺痛即切椭圆机或泳替。EA/营养: 训练日,跑前少量碳水、跑后补碳水+蛋白;有氧消耗计入当日补给,缺口别落在练日。"}, {"d": "周三", "tag": "真休", "t": "真休1 · 恢复造缺口日", "x": "活动: 仅低强度活动度课15–20min + 全身静态拉伸;可选筋膜刀IASTM(先跟PT学、避骨突与急性区、不追出痧)放松股四/下背/小腿。主课: 完全休息或轻松散步,睡眠优先(目标7.5h+),记录晨脉/HRV/主观恢复。护膝护腰: 零负重,针对性放松下背与股四,热敷下背。EA/营养: 休息日为造缺口主力日,热量下调但守个体化地板(≥1700);蛋白不减(≥2.2g/kg)、脂肪≥1.0g/kg,以维持饱腹与瘦体重。"}, {"d": "周四", "tag": "拳击", "t": "拳击 · 技术+有氧间歇(低冲击高心率)", "x": "热身: 原地碎步/影子拳代替跳绳(低冲击)、肩颈与胸椎活动、髋激活。主课: 技术+有氧间歇50–60min,以空击/打靶/打包为主,3min on/1min off×8–10回合,RPE6–8。**仅技术训练,不做硬实战对抗以规避不可控头部冲击/脑震荡风险。** 护膝护腰: 出拳靠转髋+核心发力、脊柱中立不过度后仰;步法贴地不跳跃以降冲击。EA/营养: 训练日吃够,间歇耗能大,练中补电解质、练后补碳水+蛋白。"}, {"d": "周五", "tag": "力量", "t": "力量B · 单腿/上肢/抗旋核心", "x": "热身: 动态热身 + 肩胛/髋激活 + prehab(臀中蚌式、VMO静蹲、胫前提拉各2组)。主课: 单腿罗马尼亚硬拉(或六角杠硬拉)3×8@RPE7 → 箱式台阶step-up 3×10/侧@RPE6 → 上肢推拉(俯卧撑/坐姿划船/肩推)各3×10@RPE7 → 抗旋Pallof press 3×12/侧 + 鸟狗3×8/侧。护膝护腰: 单腿动作控制不内扣、step-up全脚掌发力;Pallof抗旋稳腰、铰链保持中立脊柱。EA/营养: 训练日吃够,练后乳清/蛋+碳水;蛋白守2.2–2.4g/kg。"}, {"d": "周六", "tag": "混合有氧", "t": "Z2长跑+少量上坡冲刺(或攀岩试水)", "x": "热身: 充分10min动态 + 渐进加速跑 + 臀中/胫前激活。主课(二选一): A) Z2跑35–45min + 上坡冲刺6–8×15–20s(缓坡、走回完全恢复;上坡降离心冲击、不做下坡冲刺);B) 顶绳/低难度攀岩60–90min(技能+无氧间歇,非Z2)。两项均为本周唯一轻冲击项、互不背靠背,疲劳即删。护膝护腰: 上坡保护膝离心、攀岩注意落地缓冲与抓握别用腰代偿、禁drop-knee内扣挂膝。EA/营养: 训练日吃够,本周最长有氧日,提前补足碳水、练后补给充分。"}, {"d": "周日", "tag": "真休", "t": "真休2 · 活动度+复盘备餐", "x": "活动: 活动度课 + 静态拉伸(髋/胸椎/下背),可选筋膜刀辅助;本周备餐与睡眠管理。主课: 完全休息。监测: 汇总本周sRPE、晨脉/HRV趋势、月经日历,异常则下周降级。护膝护腰: 零负重,下背热敷放松、轻柔猫驼与髋屈拉伸。EA/营养: 休息日造缺口,守个体化地板与蛋白下限;以周为单位核对周均-400~-500kcal、单周净降≤0.6%体重(超则次周回调)。"}]}, {"key": "p2", "name": "P2 · 拓展项目", "wr": "65→60kg", "days": [{"d": "周一", "tag": "力量A+落地启动", "t": "下肢髋主导 + 软着陆启蒙", "x": "热身10min:动态髋绕环/弓步走/踝泵 + prehab(VMO、臀中、胫前激活、抗伸展死虫)。主课·力量A(下肢髋主导):高箱深蹲3×8@RPE7、罗马尼亚硬拉3×8@RPE7、保加利亚分腿蹲3×10/侧@RPE7、臀桥3×12;落地启动:20cm低台软着陆+对称落地4×5(慢、静默落地、屈髋屈膝缓冲,不做连续跳)。护膝护腰:深蹲坐箱限深度、膝对脚尖不内扣;硬拉走髋铰链、脊柱中立,禁屈曲+旋转负重。EA/营养:训练日吃够(EA≥40–45×FFM),练后乳清30–40g+碳水;全天蛋白约140g、脂肪≥1.0g/kg,碳水集中在练前后。"}, {"d": "周二", "tag": "攀岩(技能/无氧)", "t": "攀岩常规课 + 上肢核心", "x": "热身10min:肩袖弹力带、手指渐进抓握、动态上肢 + 抗旋核心(Pallof press)。主课·攀岩90min:技能为主(脚法/重心转移/静态move)+ 短线抱石无氧间歇(攀∶歇≈1∶3,4–6组);辅上肢水平拉 + 核心抗旋。护膝护腰:用抱石垫、控制坠落高度避免高轴向冲击;**严禁drop-knee内扣挂膝**;大动作发力不猛拧下背。EA/营养:训练日吃够,攀岩中等消耗,练前补碳水、练后补蛋白;全天蛋白约140g、脂肪≥1.0g/kg。"}, {"d": "周三", "tag": "真休+恢复课", "t": "活动度/拉伸 + 筋膜刀", "x": "无主课·真休。恢复课:活动度/拉伸1次(动态在前、静态在后,髋/胸椎/踝为重点)+ 筋膜刀IASTM(用PT所教手法、避骨突与急性区、不追出痧)。日常多走路、睡眠优先,记录晨脉/HRV/月经。护膝护腰:活动度只到无痛幅度,不暴力扳。EA/营养:休息日为造缺口主力日,热量调低但蛋白维持约140g、脂肪≥1.0g/kg,绝不破个体化地板;铁:富铁餐(瘦猪/蛋黄/豆制品/深绿叶)配维C,必要时隔天补铁。"}, {"d": "周四", "tag": "跑步(低冲击间歇)", "t": "Z2慢跑 + 上坡冲刺", "x": "热身10min:动态 + 踝髋活动 + 臀中/胫前激活。主课·跑步(低冲击间歇):Z2慢跑40min + 上坡冲刺6×20s(上坡降轴向冲击,走下坡回);跑量温和递增,膝/疲劳报警即改游泳替代。护膝护腰:Z2为主、缓冲跑鞋、落地不过伸膝;全程核心张力稳下背。EA/营养:训练日吃够,跑后碳水+蛋白补充;全天蛋白约140g、脂肪≥1.0g/kg,按消耗上调当日摄入。"}, {"d": "周五", "tag": "力量B+拳击", "t": "上肢拉主导 + 拳击技术", "x": "热身10min:全身动态 + 肩髋prehab + 抗伸展(死虫/鸟狗)。主课·力量B(上肢拉主导):引体或高位下拉4×8@RPE7、哑铃卧推3×8@RPE7、单臂划船3×10@RPE7、农夫行走3×30m;髋铰链补充。拳击:技术 + combo打靶3–4回合(出拳由髋发力、核心抗旋,**仅技术不硬实战**)。护膝护腰:转体靠髋旋不靠下背代偿;力量全程中立脊柱、膝不内扣。EA/营养:训练日吃够,力量+拳击双项消耗较高,适度上调碳水;蛋白约140g、脂肪≥1.0g/kg。"}, {"d": "周六", "tag": "游泳/SUP(替代冲浪)", "t": "零冲击有氧 + 桨板", "x": "热身8min:肩/踝活动度 + 轻量动员。主课·游泳/SUP(替代冲浪与部分跑步冲击):游泳45–60min以自由泳为主(零冲击Z2有氧),或桨板SUP巡航;强度Z2、连续有氧。护膝护腰:游泳对膝友好,蛙泳腿少用以免膝内侧压;SUP保持中立站姿、核心收紧护下背。EA/营养:训练日吃够但中等,关注周均缺口-300~-400kcal;蛋白约140g、脂肪≥1.0g/kg,不破个体化地板。"}, {"d": "周日", "tag": "真休", "t": "完全休息 + 主动减脂日", "x": "无主课·真休。完全休息或轻散步,睡眠与恢复优先,可做10min轻柔静态拉伸;汇总本周sRPE/HRV/月经趋势。护膝护腰:本日不安排任何冲击/负重。EA/营养:休息日造缺口,蛋白维持约140g、脂肪≥1.0g/kg,热量不破个体化地板;每日补剂:维D、钙、Omega-3、肌酸3–5g,按医嘱监控铁蛋白决定补铁。"}]}, {"key": "p3", "name": "P3 · 多项融合", "wr": "60→56kg", "days": [{"d": "周一", "tag": "力量", "t": "下肢力量 + Prehab(地基日)", "x": "热身:5min划船升温→动态(髋绕环/最伟大拉伸/弓步走)→prehab激活(蚌式+侧桥练臀中、终末伸膝练VMO、坐姿提踵练胫前)→死虫抗伸展。主课(力量第1次):高脚杯深蹲4×8@RPE7(到平行即可)、罗马尼亚硬拉3×8@RPE7、后脚抬高分腿蹲3×10/侧@RPE7、臀推3×12@RPE7、Pallof抗旋3×12/侧。护膝护腰:深蹲膝对准2–3脚趾不内扣、控制离心不追深蹲到底;硬拉全程腹内压、脊柱中立、严禁屈曲+旋转负重。EA/营养:训练日吃够(EA≥40–45×FFM+训练耗),蛋白约130–140g(三餐各35g+训后乳清25g),碳水训前后铺满保表现,脂肪≥1.0g/kg,肌酸5g;无牛羊重点补铁——深绿叶菜配维C。"}, {"d": "周二", "tag": "有氧 / 技能", "t": "Z2长跑 + 跑酷地面drill(零落差,不计高冲击)", "x": "热身:关节活动→动态拉伸→慢跑500m渐进提速。主课:①Z2有氧——8:30–9:00/km、10–12km不间断,作早期高效低冲击燃脂引擎(心率守Z2);②跑酷仅地面基础drill:垫上前/侧滚翻 + 低位落地缓冲力学(屈髋屈膝吸收),**零落差、只练落地不做跳跃,15–20min**。**豁免说明:此处跑酷=零落差地面落地drill,不计为高冲击,故可与跑步同日;与'高冲击不与跑步背靠背'规则不冲突。** 护膝护腰:跑姿高步频轻落地、不过度跨步减膝冲击;跑酷必须落地技术先行、落差封顶为0、软垫上练、滚翻按脊柱节段顺序护颈背,疲劳即删。EA/营养:长有氧后碳:蛋=3:1补糖原,蛋白守2.2–2.4g/kg;维D+钙+Omega-3,补足电解质水分。"}, {"d": "周三", "tag": "真休 1", "t": "活动度课 + IASTM 恢复(造缺口)", "x": "主课(真休息日):活动度/灵活性课30–40min(动态在前、静态在后)+ 筋膜刀IASTM辅助松解(只刮跟PT学过的部位)+ 轻散步;记录晨脉/HRV/月经。护膝护腰:IASTM避开膝周骨突与腰椎棘突、急性疼痛区不刮、不追出痧;静态拉伸不弹震、循序到舒适张力即可。EA/营养:本日是周均-250~-350kcal缺口的主要来源——降碳水,但蛋白守住约130–140g保肌,脂肪≥1.0g/kg,个体化地板绝不破;肌酸5g照常。"}, {"d": "周四", "tag": "力量 / 无氧", "t": "上肢后链力量 + 拳击间歇(仅技术)", "x": "热身:升温→肩袖+胸椎灵活→臀中激活→抗旋核心。主课(力量第2次):引体/高位下拉4×8@RPE7、单臂哑铃划船3×10/侧@RPE7、上斜哑铃卧推3×10@RPE7、农夫行走3×30m(抗侧屈核心);随后拳击技术间歇——打靶/空击30s on/30s off×8–10轮(无氧间歇、脚步轻、低冲击、**不硬实战**)。护膝护腰:拳击转髋发力、避免腰椎过度旋转代偿、核心始终收紧;划船脊柱中立不耸肩不塌腰。EA/营养:训练日吃够,蛋白分次摄入、训后乳清25g,碳水支撑拳击间歇供能,肌酸5g;铁——鱼/虾/蛋配维C同餐提升吸收。"}, {"d": "周五", "tag": "技能 / 低冲击", "t": "攀岩顶绳技术线 + 游泳(冲浪季节替代)", "x": "热身:前臂/手指渐进激活→肩袖→慢爬1条热身线路。主课:①攀岩顶绳/技术线(非抱石)——技能与无氧间歇、中低强度、重点动作经济性与脚法,45–60min不到力竭,**禁drop-knee**;②低冲击有氧:游泳或SUP 20–30min(北京无海,作冲浪的季节性零冲击替代)。护膝护腰:攀岩高抬腿避免膝过度内扣、四点支撑稳落;游泳避免蛙泳过度挺腰,选自由泳/仰泳护下背。EA/营养:训练日吃够,攀岩前中补碳水维持握力耐力,蛋白维持;Omega-3抗炎;明日高冲击——今日不堆疲劳、保证8h睡眠。"}, {"d": "周六", "tag": "高冲击(本周唯一)", "t": "抱石 Bouldering(需骨科'冲击落地'专项放行后)", "x": "前提:抱石坠落=膝轴向+旋转冲击事件,**须先经骨科/PT针对'冲击落地'专项放行**;未放行则本日替换为顶绳技术线或低冲击有氧。热身:必须充分!前臂/肩/髋全身激活→地面落地缓冲预演→2–3条慢线路热身。主课:抱石——本周唯一高冲击项(隔周仅1项、与其他冲击不背靠背),中等难度技术线为主、控制坠落与落地缓冲,40–50min、组间充分休息;严控坠落高度、必用crash pad、落地双脚同时屈髋屈膝吸收。护膝护腰:落地不锁膝、不单腿崴落、不从高点硬跳、**禁drop-knee**;下背中立、落地不塌腰;动作变形或疲劳立即停。EA/营养:抱石前碳水充足保爆发,训后蛋白+碳水恢复,肌酸5g;蛋白2.2–2.4g/kg守牢——P3保肌优先级已压过减重速度。"}, {"d": "周日", "tag": "真休 2", "t": "完全休息 + 周复盘称重", "x": "主课:完全休息或极轻散步/动态拉伸,睡眠与压力管理优先;汇总本周sRPE/HRV/月经日历。护膝护腰:全身放松,给膝/腰做主观恢复打分;若持续不适→记录,必要时PT复诊(医疗前置是硬门槛)。EA/营养:降碳水保蛋白,脂肪≥1.0g/kg、个体化地板不破。周日量7天体重均值:净降>0.6%体重立即缩小缺口;P3缺口本就小(周均-250~-350),diet break加密到每6周插1–2周。"}]}, {"key": "p4", "name": "P4 · 精修收尾", "wr": "56→52kg", "days": [{"d": "周一", "tag": "力量A · 保肌核心", "t": "下肢力量(护膝护腰主轴)", "x": "热身:划船/快走5min升温 + 髋踝动态激活(臀中/VMO/胫前)+ 死虫式抗伸展核心。主课(单一模态):高脚杯深蹲3×8@RPE7、罗马尼亚硬拉3×8@RPE7、单腿臀桥3×10、农夫行走3×30m、Pallof抗旋3×12;精修期保负荷别降量,每组留2–3次余量不力竭。护膝护腰:深蹲膝追脚尖不内扣、深度以无痛为限;硬拉髋铰链中立脊柱、禁屈曲+旋转、先收紧核心再发力。EA/营养:训练日吃够(EA≥40–45×FFM+当日消耗),练前后碳水+乳清,蛋白2.4g/kg(约130g),不额外造缺口,瘦猪/蛋配维C补铁。"}, {"d": "周二", "tag": "低冲击有氧", "t": "Z2慢跑或游泳(单一模态)", "x": "热身:动态拉伸在前、慢跑/入水渐进升速 + prehab(VMO/臀中/胫前)。主课(单一低冲击有氧,二选一):Z2慢跑40–50min(8:00/km舒适,膝伤约束跑量只温和加,可用上坡走替代部分冲击)或游泳45min(零冲击)。**不再叠加攀岩等第二项,降单日密度。** 护膝:跑前膝周热身、落地缓冲,膝不适即换游泳。EA/营养:训练日,有氧消耗后吃回补足,蛋白足量、碳水围绕训练,本日不叠加缺口。"}, {"d": "周三", "tag": "真休 · 恢复", "t": "主动恢复(筋膜刀+拉伸课)", "x": "无主课。主课:筋膜刀IASTM(辅助活动度、不追出痧、避骨突与急性痛区、跟PT学过的手法)+ 拉伸课(动态在前、静态在后)20–30min;记录晨脉/HRV/月经。护膝护腰:筋膜刀避开膝/腰骨突及急性区,静态拉伸不弹震、不到疼痛终点。EA/营养:休息日承担主要缺口——周均-150~-250kcal主要来自本日,但不破个体化地板;蛋白维持2.4g/kg保肌、脂肪≥1.0g/kg;留意睡眠与情绪。"}, {"d": "周四", "tag": "力量B + 轻技能", "t": "上肢力量(+可选极轻拳击技术)", "x": "热身:升温 + 肩/胸椎活动度 + 臀中激活 + 抗旋核心。主课:上斜哑铃卧推3×8@RPE7、单臂划船3×10、过头推举3×8@RPE7(肋骨下沉不塌腰)、壶铃硬拉3×8补髋铰链;保负荷不降量、留2–3次余量。**可选**:拳击技术10–12min(空击/手靶,练步法,非高冲击、非实战);疲劳则删,以力量为主。护腰:过头动作抗伸展核心先收紧防腰塌;拳击转体以转髋带动、不强行旋腰。EA/营养:训练日吃够,练后乳清+碳;蛋白2.4g/kg,不额外造缺口。"}, {"d": "周五", "tag": "真休 / 机会型", "t": "真休或主动恢复(高冲击机会窗)", "x": "默认真休(本阶段真休≥3天/周)。**机会型高冲击窗(仅在状态良好、轴向/冲击落地已放行、且本隔周轮到时启用,否则保持真休):** 蹦床低量20min(本周若为蹦床周)或跑酷地面drill(隔周替代,二者不同周、不背靠背、疲劳即删)。护膝护腰:蹦床落地屈髋屈膝缓冲、轴线对齐不内扣、严格控时控量;跑酷零/低落差、滚翻技术先行;膝腰任何不适立即停并转真休。EA/营养:若进行高冲击则按训练日吃够、碳水充足支撑恢复;若真休则按休息日造缺口、守地板。"}, {"d": "周六", "tag": "有氧+活动度", "t": "Z2慢跑(稍长)+ 活动度课", "x": "热身:动态热身 + prehab(VMO/臀中/胫前)。主课:Z2慢跑45–55min(用上坡走/上坡冲刺替代部分冲击以降膝压)+ 每周1次活动度课30min(髋/胸椎/踝)。护膝:长跑控配速、上坡降冲击、足底落地缓冲,膝痛即转游泳。EA/营养:训练日吃够补有氧消耗,本日不叠缺口;铁蛋白偏低则富铁餐+维C、必要时隔天补铁。"}, {"d": "周日", "tag": "真休 · 监测闸门", "t": "完全休息 + 状态自检", "x": "无主课。主课:完全休息或散步,睡眠优先;每日基础prehab(抗伸展/抗旋核心、VMO/臀中)做迷你版即可;汇总本周sRPE/HRV/月经日历。护膝护腰:被动恢复,不做负重屈曲+旋转、不做高冲击。EA/营养:休息日造缺口(周均-150~-250),严守个体化地板,蛋白2.4g/kg保肌。闸门自检:月经紊乱/铁蛋白走低/表现明显下滑/睡眠情绪变差任一出现=立即停止减脂、回到维持,接受停在54–56kg;54kg做中段二级复评、52kg须以体成分/月经/血检复评放行,不以体重秤决定。"}]}];
  var WD=['周一','周二','周三','周四','周五','周六','周日'];

  /* ===================== daily tracker (ported verbatim; reads composite DENT / writes hx) ===================== */
  function dPhaseObj(){var P=DPLAN||PDATA;for(var i=0;i<P.length;i++){if(P[i].key===DS.phase)return P[i];}return P[0];}
  function dBaseMon(){return dMon(DS.start?dParse(DS.start):new Date());}
  function dRender(){
    var ph=dPhaseObj(), off=DS.offset||0, ws=dAdd(dBaseMon(),off*7);
    var lab=document.getElementById('dWeekLabel');
    if(lab)lab.textContent='第 '+(off+1)+' 周 · '+dmd(ws)+'–'+dmd(dAdd(ws,6))+' · '+ph.name;
    var box=document.getElementById('dDays'); if(!box)return; var html=''; var done=0, train=0; var reflowed=false;
    for(var i=0;i<7;i++){
      var date=dAdd(ws,i), id=diso(date), day=ph.days[i]||{d:WD[i],tag:'',t:'',x:''}, e=DENT[id]||{};
      var adj=(DREFLOW&&typeof dAdjustDay==='function')?dAdjustDay(day,date):null; if(adj)reflowed=true;
      var rest=dIsRest(day.tag); if(!rest)train++; if(!rest&&e.done)done++;
      var note=(e.note||'').replace(/"/g,'&quot;');
      var sTag=adj?adj.tag:day.tag, sT=adj?adj.t:day.t;
      html+='<div class="dday'+(e.done?' done':'')+(rest?' rest':'')+(adj?' adj':'')+'">'+
        '<div class="dd">'+WD[i]+'<b>'+dmd(date)+'</b></div>'+
        '<div class="dc"><div class="sess"><span class="ty">'+dEsc(sTag)+'</span>'+dEsc(sT)+(adj?'<span class="adjchip">调整后</span>':'')+'<span class="dx" data-x="1">详情▾</span></div>'+
        (adj?'<div class="adjnote">'+dEsc(adj.note)+'</div>':'')+
        '<div class="det">'+dEsc(day.x)+'</div>'+
        '<div class="drow">'+
          '<label><input type="checkbox" data-d="'+id+'" data-k="done"'+(e.done?' checked':'')+'>完成</label>'+
          '<label>晨重<input type="number" step="0.1" inputmode="decimal" data-d="'+id+'" data-k="w" value="'+(e.w||'')+'"></label>'+
          '<label>体脂<input type="number" step="0.1" inputmode="decimal" data-d="'+id+'" data-k="bf" value="'+(e.bf||'')+'"></label>'+
          '<input type="text" placeholder="感受/RPE/月经/伤痛…" data-d="'+id+'" data-k="note" value="'+note+'">'+
        '</div></div></div>';
    }
    box.innerHTML=html;
    var sum=document.getElementById('dWeekSum');
    if(sum)sum.textContent='训练完成 '+done+'/'+train+(reflowed?' · 已按今日状态重排':'');
  }
  function dInit(opts){
    opts=opts||{};
    var sel=document.getElementById('dPhase');
    var P=DPLAN||PDATA;
    if(sel)sel.innerHTML=P.map(function(p){return '<option value="'+p.key+'"'+(DS.phase===p.key?' selected':'')+'>'+dEsc(p.name)+'</option>';}).join('');
    if(!DS.phase)DS.phase=P[0].key;
    var st=document.getElementById('dStart');
    if(!DS.start)DS.start=opts.start||diso(new Date());
    if(st)st.value=DS.start;
    save();
  }

  /* ===================== autoregulation (ported verbatim; arLoad/arSave -> hx.load) ===================== */
  function arLoad(){return HXS.load;}
  function arSave(d){HXS.load=d;save();}
  function arLP(e){if(!e||!e.tier)return 0;var I={'轻':1,'中':2,'大':3}[e.tier]||0;var du=+e.dur||0;var T=du<30?0.5:du<60?1:du<90?1.5:2;var rp=+e.rpe||0;var R=rp<=4?0.8:rp<=6?1:rp<=8?1.3:1.6;var lp=I*T*R;if(e.tier==='大')lp=Math.max(lp,4);return Math.round(lp*10)/10;}
  function arHard(e){if(!e)return false;return arLP(e)>=4||e.tier==='大'||(+e.rpe>=8);}
  var AR_ST={
   on_plan:{c:'green',l:'按计划',t:'照原计划,可正常上中/大强度(攀岩/拳击/力量/HYROX 等)。',d:'标准减脂 ~1850–1950 kcal:蛋白 110–120g 均分、碳水 200–220g 围训练、脂肪 55–60g。'},
   deload_lowimpact:{c:'yellow',l:'减量 · 低冲击',t:'总量降 30–40%、去高冲击(跑/跑酷/蹦床→游泳/划船/单车/技术攀岩),力量 RPE6–7 不冲重量,45–60min,护膝背。',d:'~1700–1800 kcal:蛋白不降 ~110–115g,碳水降到 150–170g 留训练窗口,脂肪 50–55g。'},
   active_recovery:{c:'orange',l:'主动恢复',t:'今日不安排训练刺激:30–40min 轻有氧(散步/慢游/骑行 RPE≤4)+ 拉伸放松,可轻技术抱石。绝不补强度。',d:'回到近维持 ~2000–2150 kcal(不造缺口):蛋白拉满 125–135g + 睡前慢蛋白,碳水保 200–220g 补糖原,脂肪 60–70g 抗炎(三文鱼/牛油果),补电解质。'},
   fullrest_deload:{c:'red',l:'全休 + 本周 deload',t:'今日全休(可 10–15min 散步/轻拉伸);本周量降 40–50%、强度封顶 RPE6、停冲击与大重量,直到不累再回升。',d:'热量回维持 ~2000–2150 kcal(diet break,别加缺口):蛋白高位 110–120g,碳水够吃 130–150g,脂肪偏抗炎;经期加铁+维C。'},
   medical_referral:{c:'red',l:'就医分诊 · 暂停该部位',t:'停止该部位负重与冲击,立即就医/物理治疗评估;未明确诊断前不自行恢复训练。',d:'热量回维持、蛋白保高位护肌、脂肪偏抗炎,减油炸酒精糖,足量补水。伤情待查期不减脂。'}
  };
  function arRec(today,fl){
    var store=arLoad(),t=arPar(today),lps=[],hd=[];
    for(var i=1;i<=3;i++){var e=store[arISO(arAddD(t,-i))];lps.push(e?arLP(e):0);hd.push(e?arHard(e):false);}
    var sum=Math.round((lps[0]+lps[1]+lps[2])*10)/10,y=lps[0],cc=0;
    for(var j=0;j<3;j++){if(hd[j])cc++;else break;}
    var so=fl.sore||0,key;
    if(fl.med)key='medical_referral';
    else if(fl.red||cc>=3||sum>=15||so>=3)key='fullrest_deload';
    else if(cc>=2||sum>=11||y>=7||so>=2)key='active_recovery';
    else if(hd[0]||(sum>=7&&sum<=10)||so===1)key='deload_lowimpact';
    else key='on_plan';
    return {key:key,sum:sum,cc:cc,y:y};
  }
  function arPanel(){
    var rEl=document.getElementById('arRed'),mEl=document.getElementById('arMed'),sEl=document.getElementById('arSore'),p=document.getElementById('arPanel');
    if(!p)return;
    var fl={red:rEl?rEl.checked:false,med:mEl?mEl.checked:false,sore:sEl?+sEl.value:0};
    var today=arISO(new Date()),r=arRec(today,fl),st=AR_ST[r.key];
    p.className='arpanel '+st.c;
    p.innerHTML='<div class="lab">今日建议 · '+today+'</div><h4>'+st.l+'</h4>'+
      '<div class="row"><b>训练:</b>'+st.t+'</div><div class="row"><b>饮食:</b>'+st.d+'</div>'+
      '<div class="row" style="font-size:.76rem;opacity:.85;">依据:近3天负荷 sumLP3='+r.sum+' · 连续硬日='+r.cc+' · 昨日LP='+r.y+(fl.med?' · ⚠就医旗':'')+(fl.red?' · ⚠红旗':'')+'</div>';
  }
  function arRecent(){
    var store=arLoad(),ks=Object.keys(store).sort().reverse().slice(0,7),box=document.getElementById('arRecent');
    if(!box)return;
    box.innerHTML=ks.length?ks.map(function(k){var e=store[k],lp=arLP(e);return '<div class="r"><span>'+k+' · '+(e.act||((e.tier||'?')+'强度'))+'</span><span><b>LP '+lp+'</b>'+(arHard(e)?' <span class="hd">硬日</span>':'')+'</span></div>';}).join(''):'<div class="r" style="color:var(--muted)">还没记最近的负荷——先把 6/27(HYROX)、6/28(登山)记进去,看今天建议。</div>';
  }
  function arAdd(){var d=document.getElementById('arDate').value;if(!d){return;}var store=arLoad();store[d]={type:document.getElementById('arType').value,tier:document.getElementById('arTier').value,rpe:document.getElementById('arRpe').value,dur:document.getElementById('arDur').value,act:document.getElementById('arAct').value};arSave(store);['arType','arTier','arRpe','arDur','arAct'].forEach(function(id){var el=document.getElementById(id);if(el)el.value=(id==='arTier'?'':'');});arRecent();arPanel();if(typeof dynRender==='function')dynRender();if(typeof dRender==='function')dRender();}

  /* ===================== dynamic engine (ported verbatim; dynLoad/dynSave -> hx.profile/hx.meals) ===================== */
  function dynLoad(){return {profile:HXS.profile,meals:HXS.meals};}
  function dynSave(o){if(o&&o.profile)HXS.profile=o.profile;if(o&&o.meals)HXS.meals=o.meals;save();}
  function dynProfile(){var p=(dynLoad().profile)||{};return {age:+p.age||38,cm:+p.cm||165,targetKg:+p.targetKg||59,rateKgWk:(p.rateKgWk!=null&&!isNaN(+p.rateKgWk)?+p.rateKgWk:0.5),floorKcal:+p.floorKcal||1450,protPerKg:(p.protPerKg!=null&&!isNaN(+p.protPerKg)?+p.protPerKg:1.8)};}
  var DYNMET={'跑步':9.5,'骑行':8,'徒步':6.5,'登山':7.5,'攀岩':7.5,'拳击':10,'冲浪':5,'跑酷':8,'力量':5,'蹦床':4,'HYROX':10,'游泳':7,'其他':6};
  function dynTierAdj(t){return t==='轻'?-1.5:(t==='大'?1.5:0);}
  function dynKcal(type,min,tier,kg){var m=(DYNMET[type]||6)+dynTierAdj(tier);if(m<3)m=3;return Math.round(m*3.5*kg/200*(+min||0));}
  function dynLatestKg(){var ks=Object.keys(DENT).filter(function(k){return DENT[k]&&DENT[k].w&&!isNaN(+DENT[k].w);}).sort();if(ks.length)return +DENT[ks[ks.length-1]].w;var tw=document.getElementById('tw');if(tw&&+tw.value)return +tw.value;return 74;}
  function dynBMR(kg){var p=dynProfile();return Math.round(10*kg+6.25*p.cm-5*p.age-161);}
  function dynActK(iso){var e=arLoad()[iso];if(!e)return 0;return dynKcal(e.type||'其他',e.dur,e.tier,dynLatestKg());}
  function dynTDEEfor(iso){return Math.round(dynBMR(dynLatestKg())*1.3+dynActK(iso));}
  function dynMealsAll(){return dynLoad().meals||[];}
  function dynIntake(iso){return dynMealsAll().filter(function(m){return m.d===iso;}).reduce(function(s,m){return s+(+m.kcal||0);},0);}
  function dynWeekDates(ref){var mon=dMon(ref||new Date()),a=[];for(var i=0;i<7;i++)a.push(diso(dAdd(mon,i)));return a;}
  function dynWeekEnergy(){
    var p=dynProfile(),now=new Date(),wk=dynWeekDates(now),todayIso=diso(now),ti=wk.indexOf(todayIso);if(ti<0)ti=0;
    var weekTarget=p.rateKgWk*7700,perDayBase=weekTarget/7,deficitSoFar=0;
    for(var i=0;i<ti;i++){var iso=wk[i],intk=dynIntake(iso);if(intk>0)deficitSoFar+=(dynTDEEfor(iso)-intk);else deficitSoFar+=perDayBase;}
    var remaining=7-ti;if(remaining<1)remaining=1;
    var tdeeToday=dynTDEEfor(todayIso),intakeToday=dynIntake(todayIso);
    var remNeeded=weekTarget-deficitSoFar,perDay=remNeeded/remaining,target=Math.round(tdeeToday-perDay),floored=false;
    if(target<p.floorKcal){target=p.floorKcal;floored=true;}
    if(target>tdeeToday)target=tdeeToday;
    return {weekTarget:Math.round(weekTarget),deficitSoFar:Math.round(deficitSoFar),remaining:remaining,tdeeToday:tdeeToday,target:target,floored:floored,intakeToday:Math.round(intakeToday),remPerDay:Math.round(perDay)};
  }
  function dynTrajectory(){
    var pts=[];Object.keys(DENT).forEach(function(k){if(DENT[k]&&DENT[k].w&&!isNaN(+DENT[k].w))pts.push({t:dParse(k).getTime(),kg:+DENT[k].w});});
    pts.sort(function(a,b){return a.t-b.t;});
    var cur=pts.length?pts[pts.length-1].kg:dynLatestKg();
    if(pts.length<2)return {n:pts.length,cur:cur,tgt:dynProfile().targetKg};
    var last=pts[pts.length-1].t,win=pts.filter(function(q){return q.t>=last-14*86400000;});if(win.length<2)win=pts.slice(-2);
    var n=win.length,t0=win[0].t,sx=0,sy=0,sxy=0,sxx=0;
    win.forEach(function(q){var x=(q.t-t0)/86400000,y=q.kg;sx+=x;sy+=y;sxy+=x*y;sxx+=x*x;});
    var dn=n*sxx-sx*sx,slope=dn!==0?(n*sxy-sx*sy)/dn:0,ratePerWk=slope*7,p=dynProfile(),tgtRate=-p.rateKgWk,status,adj;
    if(ratePerWk<=tgtRate*1.25){status='偏快';adj=120;}
    else if(ratePerWk<=tgtRate*0.55){status='在轨';adj=0;}
    else {status='偏慢';adj=-120;}
    var weeksToTgt=ratePerWk<-0.02?(cur-p.targetKg)/(-ratePerWk):null;
    return {n:n,cur:cur,ratePerWk:ratePerWk,status:status,adj:adj,weeksToTgt:weeksToTgt,tgt:p.targetKg};
  }
  function dynFlags(){return {red:(document.getElementById('arRed')||{}).checked,med:(document.getElementById('arMed')||{}).checked,sore:+((document.getElementById('arSore')||{}).value||0)};}

  /* ===================== schedule reflow (ported verbatim) ===================== */
  function dAdjState(){var fl=dynFlags();return arRec(arISO(new Date()),fl).key;}
  function dAdjustDay(day,date){
    if(dIsRest(day.tag))return null;
    var todayMid=new Date();todayMid.setHours(0,0,0,0);
    var dMid=new Date(date);dMid.setHours(0,0,0,0);
    var weekEnd=dAdd(dMon(new Date()),6);weekEnd.setHours(0,0,0,0);
    if(dMid.getTime()<todayMid.getTime()||dMid.getTime()>weekEnd.getTime())return null;
    var k=dAdjState();if(k==='on_plan')return null;
    var isToday=(dMid.getTime()===todayMid.getTime()),tag,t,note;
    if(k==='medical_referral'){tag='就医分诊';t='停该部位负重与冲击，先就医/物理治疗评估';note='未明确诊断前不自行恢复该部位训练；其余部位可低强度活动。';}
    else if(k==='fullrest_deload'){if(isToday){tag='全休';t='今日全休（可 10–15min 散步/轻拉伸）';note='本周整体量降 40–50%、强度封顶 RPE6、停冲击与大重量，直到不累再回升。';}else{tag='减载';t=day.t;note='本周 deload：量降 40–50% · RPE 封顶 6 · 停高冲击与大重量（原：'+day.t+'）';}}
    else if(k==='active_recovery'){if(isToday){tag='主动恢复';t='30–40min 轻有氧（散步/慢游/骑行 RPE≤4）+ 拉伸，可轻技术抱石';note='今日不补强度。';}else{tag='减量·低冲击';t=day.t;note='量降 30–40% · 去高冲击 · 力量 RPE6–7 不冲重量（原：'+day.t+'）';}}
    else{tag='减量·低冲击';t=day.t;note='量降 30–40% · 高冲击（跑/跑酷/蹦床）→泳/划/单车/技术攀岩 · 力量 RPE6–7 · 护膝背（原：'+day.t+'）';}
    return {tag:tag,t:t,note:note};
  }

  /* ===================== dynamic render + meals + profile (ported verbatim) ===================== */
  function dynRender(){
    var box=document.getElementById('dynCards');if(!box)return;
    var p=dynProfile(),we=dynWeekEnergy(),tr=dynTrajectory(),actK=dynActK(diso(new Date())),protTarget=Math.round(p.protPerKg*p.targetKg);
    var ar=arRec(arISO(new Date()),dynFlags()),st=AR_ST[ar.key];
    var h='';
    h+='<div class="dyncard"><div class="lab">体重轨迹</div><div class="big">'+(+tr.cur).toFixed(1)+'<small> kg</small></div>'+
      (tr.n>=2?('<div class="ln">近期速率 <b>'+tr.ratePerWk.toFixed(2)+' kg/周</b> · <span class="tag">'+tr.status+'</span></div>'+
        (tr.weeksToTgt!=null?'<div class="ln">按此速率约 <b>'+Math.ceil(tr.weeksToTgt)+' 周</b> 进 '+tr.tgt+'kg 区（以体脂%为锚）</div>':'<div class="ln">目标区 <b>'+tr.tgt+'kg</b> · 17–20% 体脂</div>')+
        (tr.adj!==0?'<div class="ln" style="font-size:.72rem;">'+(tr.adj>0?'掉得偏快→今日可上调 ~'+tr.adj+' kcal，护肌防 RED-S':'掉得偏慢→可下调 ~'+(-tr.adj)+' kcal，但不破下限')+'</div>':''))
      :'<div class="ln">多记几天晨重即可拟合趋势（现 '+tr.n+' 条）</div>')+'</div>';
    h+='<div class="dyncard"><div class="lab">今日能量</div><div class="big">'+we.target+'<small> kcal 建议</small></div>'+
      '<div class="ln">TDEE 今日 <b>'+we.tdeeToday+'</b> = 基础×1.3 + 活动 '+actK+'</div>'+
      '<div class="ln">已记摄入 <b>'+we.intakeToday+'</b> · 蛋白 <b>≥'+protTarget+'g</b></div>'+
      (we.floored?'<div class="ln" style="color:var(--volt);">✓ 已到健康下限 '+p.floorKcal+' kcal：缺口靠活动而非少吃来扩大（主要在训练日）。</div>':'')+'</div>';
    h+='<div class="dyncard"><div class="lab">本周能量</div><div class="big">'+we.deficitSoFar+'<small> kcal 累计缺口</small></div>'+
      '<div class="ln">本周目标缺口 <b>'+we.weekTarget+'</b> ≈ '+p.rateKgWk+'kg</div>'+
      '<div class="ln">剩 '+we.remaining+' 天 · 每天约缺 <b>'+we.remPerDay+'</b></div>'+
      '<div class="ln" style="font-size:.72rem;">社交餐/额外活动会摊到本周剩余几天，任何一天都不低于 '+p.floorKcal+'。</div></div>';
    h+='<div class="dyncard"><div class="lab">今日训练</div><div class="big" style="font-size:1.15rem;color:var(--volt);">'+st.l+'</div>'+
      '<div class="ln">近3天负荷 sumLP3=<b>'+ar.sum+'</b>（含临时活动）</div>'+
      '<div class="ln" style="font-size:.72rem;">完整训练+饮食档位见下方「今日自适应建议」。</div></div>';
    box.innerHTML=h;
  }
  function dynMealsRender(){
    var o=dynLoad(),all=o.meals||[],ms=all.slice().sort(function(a,b){return a.d<b.d?1:(a.d>b.d?-1:0);}).slice(0,8),box=document.getElementById('dynMeals');
    if(!box)return;
    box.innerHTML=ms.length?ms.map(function(m){var gi=all.indexOf(m);return '<div class="r"><span>'+m.d+' '+(m.social?'🍽 ':'')+dEsc(m.note||'')+'</span><span><b>'+(+m.kcal||0)+' kcal</b>'+(m.protein?' · '+m.protein+'g':'')+' <span class="dx" data-mi="'+gi+'">✕</span></span></div>';}).join(''):'<div class="r" style="color:var(--muted)">还没记饮食——记几餐后，本周能量与今日目标自动重算。</div>';
  }
  function dynMealAdd(){var d=document.getElementById('mDate').value;if(!d){return;}var o=dynLoad();o.meals=o.meals||[];o.meals.push({d:d,kcal:+document.getElementById('mKcal').value||0,protein:+document.getElementById('mProt').value||0,social:document.getElementById('mSocial').checked,note:document.getElementById('mNote').value});dynSave(o);['mKcal','mProt','mNote'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});document.getElementById('mSocial').checked=false;dynMealsRender();dynRender();dToast('已记一餐，已重算');}
  function dynFillProfile(){var p=dynProfile();var s=function(id,v){var el=document.getElementById(id);if(el)el.value=v;};s('pTgt',p.targetKg);s('pRate',p.rateKgWk);s('pFloor',p.floorKcal);s('pProt',p.protPerKg);s('pAge',p.age);}

  /* ===================== mount functions (wire a page's existing markup by id) ===================== */
  // header scroll + .reveal observer + ensure a #toast exists
  HX.initChrome=function(){
    var bar=document.getElementById('bar');
    if(bar){var os=function(){bar.classList.toggle('scrolled',window.scrollY>40);};window.addEventListener('scroll',os,{passive:true});os();}
    var reveals=document.querySelectorAll('.reveal');
    if(reveals.length){
      if('IntersectionObserver' in window){
        var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){en.target.classList.add('in');io.unobserve(en.target);}});},{threshold:.12,rootMargin:'0px 0px -8% 0px'});
        reveals.forEach(function(el){io.observe(el);});
      } else { reveals.forEach(function(el){el.classList.add('in');}); }
    }
    if(!document.getElementById('toast')){var t=document.createElement('div');t.className='toast';t.id='toast';document.body.appendChild(t);}
    return HX;
  };

  // 逐日打卡 + reflow. opts:{plan, start, reflow}. No-ops if #dDays absent.
  HX.mountDaily=function(opts){
    opts=opts||{};
    if(opts.plan)DPLAN=opts.plan;
    if(opts.reflow===false)DREFLOW=false;
    var box=document.getElementById('dDays'); if(!box)return HX; // graceful no-op
    dLoad();
    dInit(opts);
    if(DS.offset===undefined){DS.offset=0;dSaveS();}
    box.addEventListener('input',function(ev){var t=ev.target,d=t.dataset.d,k=t.dataset.k;if(!d)return;dSetField(d,k,(t.type==='checkbox'?t.checked:t.value));if(k==='done')dRender();if(k==='w'||k==='bf'){if(typeof dynRender==='function')dynRender();}});
    box.addEventListener('click',function(ev){if(ev.target.dataset.x){ev.target.closest('.dc').classList.toggle('open');}});
    var bind=function(id,evt,fn){var el=document.getElementById(id);if(el)el.addEventListener(evt,fn);};
    bind('dStart','change',function(){DS.start=this.value;dSaveS();dRender();});
    bind('dPhase','change',function(){DS.phase=this.value;dSaveS();dRender();});
    bind('dPrev','click',function(){DS.offset=(DS.offset||0)-1;dSaveS();dRender();});
    bind('dNext','click',function(){DS.offset=(DS.offset||0)+1;dSaveS();dRender();});
    bind('dToday','click',function(){DS.offset=Math.round((dMon(new Date())-dBaseMon())/(7*86400000));dSaveS();dRender();});
    dRender();
    return HX;
  };

  // 总览卡 + 饮食快记 + 负荷记录 + 自适应面板 + 体重快记(tw/tbf). No-ops per-element if absent.
  HX.mountEngine=function(){
    dLoad();
    // weight quick tracker (tw/tbf) — now unified into hx.weights[today]
    var tw=document.getElementById('tw'),tbf=document.getElementById('tbf'),ts=document.getElementById('tsave');
    if(tw||tbf){
      var twLatest=function(){var ks=Object.keys(HXS.weights).sort();for(var i=ks.length-1;i>=0;i--){var g=HXS.weights[ks[i]];if(g&&(g.kg!=null&&g.kg!==''))return g;}return null;};
      var l=twLatest();
      if(l){if(tw&&l.kg!=null)tw.value=l.kg;if(tbf&&l.bf!=null)tbf.value=l.bf;}
      var twSave=function(){var d=diso(new Date());HXS.weights[d]=HXS.weights[d]||{};if(tw)HXS.weights[d].kg=tw.value;if(tbf)HXS.weights[d].bf=tbf.value;save();rebuildDENT();if(ts)ts.textContent='✓ 已存 '+new Date().toLocaleDateString('zh-CN')+' · 看趋势别盯单次';if(typeof dynRender==='function')dynRender();if(typeof dRender==='function')dRender();};
      if(tw)tw.addEventListener('input',twSave);
      if(tbf)tbf.addEventListener('input',twSave);
    }
    // autoregulation panel
    var ard=document.getElementById('arDate');if(ard&&!ard.value)ard.value=arISO(new Date());
    var arb=document.getElementById('arAddBtn');if(arb)arb.addEventListener('click',arAdd);
    ['arRed','arMed','arSore'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('change',function(){arPanel();dynRender();if(typeof dRender==='function')dRender();});});
    arRecent();arPanel();
    // dynamic engine — meals + profile
    var md=document.getElementById('mDate');if(md&&!md.value)md.value=diso(new Date());
    var mb=document.getElementById('mAddBtn');if(mb)mb.addEventListener('click',dynMealAdd);
    var ml=document.getElementById('dynMeals');if(ml)ml.addEventListener('click',function(ev){var mi=ev.target.dataset?ev.target.dataset.mi:null;if(mi==null)return;var o=dynLoad();o.meals=o.meals||[];o.meals.splice(+mi,1);dynSave(o);dynMealsRender();dynRender();});
    var ps=document.getElementById('pSave');if(ps)ps.addEventListener('click',function(){var o=dynLoad();o.profile=o.profile||{};o.profile.targetKg=+document.getElementById('pTgt').value||59;var rr=+document.getElementById('pRate').value;o.profile.rateKgWk=isNaN(rr)?0.5:rr;o.profile.floorKcal=+document.getElementById('pFloor').value||1450;o.profile.protPerKg=+document.getElementById('pProt').value||1.8;o.profile.age=+document.getElementById('pAge').value||38;dynSave(o);dynFillProfile();dynRender();dToast('参数已更新，已重算');});
    dynFillProfile();dynMealsRender();dynRender();
    return HX;
  };

  // CSV/JSON import + export. opts:{prefix}. No-ops per-element if absent.
  HX.mountExport=function(opts){
    opts=opts||{};
    var prefix=opts.prefix||'hx-daily';
    var csv=document.getElementById('dCsv'),js=document.getElementById('dJson'),imp=document.getElementById('dImport');
    if(csv)csv.addEventListener('click',function(){
      var ks=Object.keys(DENT).sort();
      var L=['﻿'+['日期','完成','晨重kg','体脂%','感受/备注'].map(dCc).join(',')];
      ks.forEach(function(d){var e=DENT[d];L.push([d,e.done?'1':'',e.w||'',e.bf||'',e.note||''].map(dCc).join(','));});
      dDl(prefix+'-'+diso(new Date())+'.csv',L.join('\r\n'),'text/csv');dToast('已导出打卡 CSV');
    });
    if(js)js.addEventListener('click',function(){
      dDl(prefix+'-'+diso(new Date())+'.json',JSON.stringify(HXS,null,2),'application/json');dToast('已下载 JSON 备份');
    });
    if(imp)imp.addEventListener('change',function(){
      var f=this.files&&this.files[0];if(!f){return;}var r=new FileReader();var self=this;
      r.onload=function(){try{
        var o=JSON.parse(r.result);
        if(o&&(o.profile||o.weights||o.days||o.load||o.meals||o.journal)){ HXS=_normalize(o); }
        else if(o&&(o.entries||o.settings)){ // legacy {settings,entries} backup
          if(o.entries&&typeof o.entries==='object'){ for(var k in o.entries){ var e=o.entries[k]||{};
            HXS.days[k]=HXS.days[k]||{}; if(e.done!=null)HXS.days[k].done=e.done; if(e.note!=null)HXS.days[k].note=e.note;
            if((e.w!=null&&e.w!=='')||(e.bf!=null&&e.bf!=='')){HXS.weights[k]=HXS.weights[k]||{};if(e.w!=null&&e.w!=='')HXS.weights[k].kg=e.w;if(e.bf!=null&&e.bf!=='')HXS.weights[k].bf=e.bf;} } }
          if(o.settings&&typeof o.settings==='object'){ for(var sk in o.settings)HXS.settings[sk]=o.settings[sk]; }
        }
        save();dLoad();
        if(typeof dInit==='function'&&document.getElementById('dDays'))dInit({});
        if(typeof dRender==='function')dRender();
        if(typeof dynFillProfile==='function')dynFillProfile();
        if(typeof dynMealsRender==='function')dynMealsRender();
        if(typeof dynRender==='function')dynRender();
        if(typeof arRecent==='function')arRecent();
        if(typeof arPanel==='function')arPanel();
        dToast('已导入恢复');
      }catch(e){dToast('导入失败');}};
      r.readAsText(f);self.value='';
    });
    return HX;
  };

  /* ===================== namespace exposure ===================== */
  HX.store={get:function(){return HXS;},set:function(o){HXS=_normalize(o);setStore(HXS);rebuildDENT();return HXS;},migrate:migrate,save:save,raw:getStore};
  HX.helpers={diso:diso,dParse:dParse,dAdd:dAdd,dMon:dMon,dmd:dmd,dpad:dpad,dEsc:dEsc,dToast:dToast,dDl:dDl,dCc:dCc,dIsRest:dIsRest};
  HX.engine={dynProfile:dynProfile,DYNMET:DYNMET,dynTierAdj:dynTierAdj,dynKcal:dynKcal,dynBMR:dynBMR,dynActK:dynActK,dynTDEEfor:dynTDEEfor,dynWeekEnergy:dynWeekEnergy,dynTrajectory:dynTrajectory,dynLatestKg:dynLatestKg,dynIntake:dynIntake,dynMealsAll:dynMealsAll,dynWeekDates:dynWeekDates};
  HX.autoreg={arRec:arRec,AR_ST:AR_ST,arLP:arLP,arHard:arHard};
  HX.reflow={dAdjustDay:dAdjustDay,dAdjState:dAdjState};
  HX.data={PDATA:PDATA,WD:WD};
  HX.migrate=migrate; // convenience alias

  /* ===================== boot: migrate once, then load live state ===================== */
  migrate();
  dLoad();
})();
