#include "NetworkManager.h"
#include "DeviceIdentity.h"
#include <WiFi.h>
#include <ArduinoJson.h>

namespace {
struct ScanEntry {
    String ssid;
    int32_t rssi = -127;
    bool secure = false;
};

const char PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>机器鱼配网</title><style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:440px;margin:24px auto;padding:16px;color:#172033;background:#f5f7fb}.card{background:white;border:1px solid #dbe3ee;border-radius:14px;padding:16px;box-shadow:0 8px 26px rgba(25,45,75,.06)}h2{margin:0 0 10px}.tip{background:#eef6ff;padding:12px;border-radius:9px;margin-bottom:14px;font-size:14px;line-height:1.5}.scan-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 8px}.scan-head strong{font-size:14px}.refresh{width:auto;margin:0;padding:8px 12px;background:#eef4ff;color:#1458c0;border:1px solid #bdd2f5}.networks{display:flex;flex-direction:column;gap:7px;max-height:260px;overflow:auto;margin-bottom:12px}.network{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;text-align:left;background:#fff;color:#172033;border:1px solid #dbe3ee;border-radius:9px;padding:10px 12px;margin:0}.network:active{background:#eef6ff}.network strong,.network small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.network small{color:#6e7d90;margin-top:3px}.signal{font-size:12px;color:#516273;white-space:nowrap}.empty{padding:14px;text-align:center;color:#7a899b;border:1px dashed #c9d4e2;border-radius:9px;font-size:13px}.manual{font-size:12px;color:#758599;margin:6px 0 4px}label{display:block;font-size:13px;color:#46576a;margin-top:10px}input,button{width:100%;box-sizing:border-box;padding:12px;margin:5px 0;border-radius:8px}input{border:1px solid #cbd6e3;background:#fff;color:#172033}button{background:#1677ff;color:white;border:0;font-weight:700}.save{margin-top:12px}.status{font-size:12px;color:#6f7f91;min-height:18px;margin:4px 0 6px}.lock{font-size:11px;color:#7c8b9d;margin-left:5px}</style></head><body><div class="card"><h2>机器鱼配网</h2><div class="tip">选择附近的 2.4 GHz Wi-Fi，输入密码后保存。设备重启后会自动广播寻找同一局域网中的控制电脑，不需要填写控制器 IP。若要重新配网，长按 BOOT 约 3 秒即可清除配置。</div><div class="scan-head"><strong>附近 Wi-Fi</strong><button class="refresh" type="button" id="refresh">重新扫描</button></div><div class="status" id="scanStatus">正在扫描附近网络…</div><div class="networks" id="networks"></div><div class="manual">如果是隐藏网络，也可以手动输入 SSID。</div><form method="post" action="/configure"><label>Wi-Fi 名称<input id="ssid" name="ssid" placeholder="SSID" maxlength="32" required></label><label>Wi-Fi 密码<input id="password" type="password" name="password" placeholder="Wi-Fi 密码" maxlength="64"></label><label>设备名称<input name="name" placeholder="设备名称" value="机器鱼"></label><button class="save" type="submit">保存并重启</button></form></div><script>const list=document.getElementById('networks'),statusEl=document.getElementById('scanStatus'),ssid=document.getElementById('ssid'),password=document.getElementById('password'),refresh=document.getElementById('refresh');function bars(rssi){if(rssi>=-50)return '████';if(rssi>=-65)return '███';if(rssi>=-75)return '██';return '█'}function render(items){list.textContent='';if(!items.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='没有扫描到可见 Wi-Fi，可手动输入 SSID';list.appendChild(empty);return}items.forEach(net=>{const button=document.createElement('button');button.type='button';button.className='network';const left=document.createElement('span');const name=document.createElement('strong');name.textContent=net.ssid;const detail=document.createElement('small');detail.textContent=(net.secure?'需要密码':'开放网络')+' · '+net.rssi+' dBm';left.appendChild(name);left.appendChild(detail);const signal=document.createElement('span');signal.className='signal';signal.textContent=bars(net.rssi)+(net.secure?' 🔒':'');button.appendChild(left);button.appendChild(signal);button.addEventListener('click',()=>{ssid.value=net.ssid;password.focus()});list.appendChild(button)})}async function scan(){refresh.disabled=true;statusEl.textContent='正在扫描附近网络…';try{const response=await fetch('/scan',{cache:'no-store'});if(!response.ok)throw new Error('扫描失败');const data=await response.json();render(data.networks||[]);statusEl.textContent='已找到 '+(data.networks||[]).length+' 个可见网络'}catch(e){render([]);statusEl.textContent='扫描失败，可手动输入 Wi-Fi 名称'}finally{refresh.disabled=false}}refresh.addEventListener('click',scan);scan();</script></body></html>)HTML";
}

NetworkManager::NetworkManager(ConfigStore& store):store_(store){}
void NetworkManager::begin(DeviceConfig& config){config_=&config; policy_.begin(config.valid(),millis());}
bool NetworkManager::connected() const{return WiFi.status()==WL_CONNECTED;}
bool NetworkManager::provisioning() const{return portalStarted_;}
void NetworkManager::connect(){WiFi.mode(WIFI_STA);WiFi.setSleep(false);WiFi.begin(config_->ssid.c_str(),config_->password.c_str());lastReconnect_=millis();}
void NetworkManager::printConnectionInfo(){
    Serial.printf(
        "[WiFi] connected SSID=%s IP=%s gateway=%s mask=%s RSSI=%d dBm\n",
        WiFi.SSID().c_str(),
        WiFi.localIP().toString().c_str(),
        WiFi.gatewayIP().toString().c_str(),
        WiFi.subnetMask().toString().c_str(),
        WiFi.RSSI()
    );
}

void NetworkManager::registerRoutes(){
    auto showPortal=[this](){server_.sendHeader("Cache-Control","no-store");server_.send(200,"text/html; charset=utf-8",PAGE);};
    server_.on("/",HTTP_GET,showPortal);
    const char* probes[]={"/generate_204","/gen_204","/hotspot-detect.html","/library/test/success.html","/connecttest.txt","/redirect","/ncsi.txt","/fwlink"};
    for(const char* path:probes)server_.on(path,HTTP_GET,showPortal);

    server_.on("/scan",HTTP_GET,[this](){
        constexpr size_t kMaxNetworks=20;
        ScanEntry entries[kMaxNetworks];
        size_t count=0;
        int found=WiFi.scanNetworks(false,false);
        if(found<0){server_.send(503,"application/json; charset=utf-8","{\"networks\":[]}");return;}
        for(int i=0;i<found;i++){
            String name=WiFi.SSID(i);
            if(name.length()==0)continue;
            int32_t rssi=WiFi.RSSI(i);
            bool secure=WiFi.encryptionType(i)!=WIFI_AUTH_OPEN;
            size_t duplicate=kMaxNetworks;
            for(size_t j=0;j<count;j++)if(entries[j].ssid==name){duplicate=j;break;}
            if(duplicate<kMaxNetworks){
                if(rssi>entries[duplicate].rssi){entries[duplicate].rssi=rssi;entries[duplicate].secure=secure;}
                continue;
            }
            if(count<kMaxNetworks){entries[count].ssid=name;entries[count].rssi=rssi;entries[count].secure=secure;count++;}
        }
        for(size_t i=0;i<count;i++)for(size_t j=i+1;j<count;j++)if(entries[j].rssi>entries[i].rssi){ScanEntry tmp=entries[i];entries[i]=entries[j];entries[j]=tmp;}
        JsonDocument doc;JsonArray networks=doc["networks"].to<JsonArray>();
        for(size_t i=0;i<count;i++){JsonObject item=networks.add<JsonObject>();item["ssid"]=entries[i].ssid;item["rssi"]=entries[i].rssi;item["secure"]=entries[i].secure;}
        String out;serializeJson(doc,out);WiFi.scanDelete();server_.sendHeader("Cache-Control","no-store");server_.send(200,"application/json; charset=utf-8",out);
    });

    server_.on("/configure",HTTP_POST,[this](){
        DeviceConfig c; c.ssid=server_.arg("ssid");c.password=server_.arg("password");c.controllerHost="";c.displayName=server_.arg("name");
        if(!c.valid()){server_.send(400,"text/plain; charset=utf-8","配置无效，请检查所有字段");return;}
        if(!store_.save(c)){server_.send(500,"text/plain; charset=utf-8","保存失败");return;}
        server_.send(200,"text/plain; charset=utf-8","保存成功，设备正在重启");delay(300);ESP.restart();
    });
    server_.onNotFound([this](){server_.sendHeader("Location","http://192.168.4.1/",true);server_.send(302,"text/plain; charset=utf-8","正在打开机器鱼配网页");});
}

void NetworkManager::startProvisioning(){
    WiFi.disconnect(true);WiFi.mode(WIFI_AP_STA);String ap=provisioningApName();WiFi.softAP(ap.c_str());
    dnsServer_.setErrorReplyCode(DNSReplyCode::NoError);dnsServer_.start(53,"*",WiFi.softAPIP());
    registerRoutes();server_.begin();portalStarted_=true;
}

void NetworkManager::update(uint32_t nowMs){
    if(portalStarted_){dnsServer_.processNextRequest();server_.handleClient();return;}
    bool online=connected();policy_.setConnected(online,nowMs);
    if(online){
        if(!lastConnected_){
            printConnectionInfo();
            lastConnected_=true;
        }
        return;
    }
    lastConnected_=false;
    NetworkAction action=policy_.next(nowMs);
    if(action==NetworkAction::Connect)connect(); else if(action==NetworkAction::StartProvisioning)startProvisioning();
    else if(nowMs-lastReconnect_>=15000)connect();
}
