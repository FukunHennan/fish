#include "NetworkManager.h"
#include "DeviceIdentity.h"
#include "OtaPage.h"
#include <WiFi.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <Preferences.h>
#include "AppConfig.h"

namespace {
struct ScanEntry {
    String ssid;
    int32_t rssi = -127;
    bool secure = false;
};

constexpr uint32_t kWifiAttemptTimeoutMs = 30000;
constexpr uint32_t kWifiReconnectIntervalMs = 30000;
constexpr uint32_t kWifiStatusLogIntervalMs = 10000;

const char* wifiStatusName(int status) {
    switch (status) {
        case WL_IDLE_STATUS: return "IDLE";
        case WL_NO_SSID_AVAIL: return "NO_SSID";
        case WL_SCAN_COMPLETED: return "SCAN_DONE";
        case WL_CONNECTED: return "CONNECTED";
        case WL_CONNECT_FAILED: return "CONNECT_FAILED";
        case WL_CONNECTION_LOST: return "CONNECTION_LOST";
        case WL_DISCONNECTED: return "DISCONNECTED";
        default: return "UNKNOWN";
    }
}

const char PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>机器鱼配网</title><style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:440px;margin:24px auto;padding:16px;color:#172033;background:#f5f7fb}.card{background:white;border:1px solid #dbe3ee;border-radius:14px;padding:16px;box-shadow:0 8px 26px rgba(25,45,75,.06)}h2{margin:0 0 10px}.tip{background:#eef6ff;padding:12px;border-radius:9px;margin-bottom:14px;font-size:14px;line-height:1.5}.scan-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 8px}.scan-head strong{font-size:14px}.refresh{width:auto;margin:0;padding:8px 12px;background:#eef4ff;color:#1458c0;border:1px solid #bdd2f5}.networks{display:flex;flex-direction:column;gap:7px;max-height:260px;overflow:auto;margin-bottom:12px}.network{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;text-align:left;background:#fff;color:#172033;border:1px solid #dbe3ee;border-radius:9px;padding:10px 12px;margin:0}.network:active{background:#eef6ff}.network strong,.network small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.network small{color:#6e7d90;margin-top:3px}.signal{font-size:12px;color:#516273;white-space:nowrap}.empty{padding:14px;text-align:center;color:#7a899b;border:1px dashed #c9d4e2;border-radius:9px;font-size:13px}.manual{font-size:12px;color:#758599;margin:6px 0 4px}label{display:block;font-size:13px;color:#46576a;margin-top:10px}input,button{width:100%;box-sizing:border-box;padding:12px;margin:5px 0;border-radius:8px}input{border:1px solid #cbd6e3;background:#fff;color:#172033}button{background:#1677ff;color:white;border:0;font-weight:700}.save{margin-top:12px}.status{font-size:12px;color:#6f7f91;min-height:18px;margin:4px 0 6px}.lock{font-size:11px;color:#7c8b9d;margin-left:5px}</style></head><body><div class="card"><h2>机器鱼配网</h2><div class="tip">选择附近的 2.4 GHz Wi-Fi，输入密码后保存。设备重启后自动寻找同一局域网中的控制电脑。服务器暂时不可用时，设备会继续保持 Wi-Fi 并自动重连，不会自动进入配网；如需重新配网，请长按 BOOT 约 3 秒清除配置。</div><div class="scan-head"><strong>附近 Wi-Fi</strong><button class="refresh" type="button" id="refresh">重新扫描</button></div><div class="status" id="scanStatus">正在扫描附近网络…</div><div class="networks" id="networks"></div><div class="manual">如果是隐藏网络，也可以手动输入 SSID。</div><form method="post" action="/configure"><label>Wi-Fi 名称<input id="ssid" name="ssid" placeholder="SSID" maxlength="32" required></label><label>Wi-Fi 密码<input id="password" type="password" name="password" placeholder="Wi-Fi 密码" maxlength="64"></label><label>设备名称<input name="name" placeholder="设备名称" value="机器鱼"></label><button class="save" type="submit">保存并重启</button></form><hr><h3>离线固件恢复</h3><p>服务器无法连接时，可在这里上传 ESP32-C3 的 firmware.bin。上传期间保持供电；成功后自动重启，保留 Wi-Fi 配置。</p><form method="post" action="/update" enctype="multipart/form-data"><input type="file" name="firmware" accept=".bin" required><button type="submit">上传固件并重启</button></form></div><script>const list=document.getElementById('networks'),statusEl=document.getElementById('scanStatus'),ssid=document.getElementById('ssid'),password=document.getElementById('password'),refresh=document.getElementById('refresh');function bars(rssi){if(rssi>=-50)return '████';if(rssi>=-65)return '███';if(rssi>=-75)return '██';return '█'}function render(items){list.textContent='';if(!items.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='没有扫描到可见 Wi-Fi，可手动输入 SSID';list.appendChild(empty);return}items.forEach(net=>{const button=document.createElement('button');button.type='button';button.className='network';const left=document.createElement('span');const name=document.createElement('strong');name.textContent=net.ssid;const detail=document.createElement('small');detail.textContent=(net.secure?'需要密码':'开放网络')+' · '+net.rssi+' dBm';left.appendChild(name);left.appendChild(detail);const signal=document.createElement('span');signal.className='signal';signal.textContent=bars(net.rssi)+(net.secure?' 🔒':'');button.appendChild(left);button.appendChild(signal);button.addEventListener('click',()=>{ssid.value=net.ssid;password.focus()});list.appendChild(button)})}async function scan(){refresh.disabled=true;statusEl.textContent='正在扫描附近网络…';try{const response=await fetch('/scan',{cache:'no-store'});if(!response.ok)throw new Error('扫描失败');const data=await response.json();render(data.networks||[]);statusEl.textContent='已找到 '+(data.networks||[]).length+' 个可见网络'}catch(e){render([]);statusEl.textContent='扫描失败，可手动输入 Wi-Fi 名称'}finally{refresh.disabled=false}}refresh.addEventListener('click',scan);scan();</script></body></html>)HTML";
}

NetworkManager::NetworkManager(ConfigStore& store):store_(store){}
void NetworkManager::begin(DeviceConfig& config){
    config_=&config;
    hasSavedWifi_=config.hasSavedWifi;
    wifiAttemptStartedAt_=millis();
    // ConfigStore applies the built-in network only when NVS is empty. This
    // keeps the saved-network flag available for the recovery policy below.
    policy_.begin(config.valid(),millis(),CONTROLLER_REGISTRATION_RECOVERY_MS,CONTROLLER_PROVISIONING_WINDOW_MS);
}
bool NetworkManager::connected() const{return WiFi.status()==WL_CONNECTED;}
bool NetworkManager::provisioning() const{return portalStarted_;}
String NetworkManager::scanNetworksJson(){
    constexpr size_t kMaxNetworks=20;
    ScanEntry entries[kMaxNetworks];
    size_t count=0;
    int found=WiFi.scanNetworks(false,false);
    if(found<0)return "{\"networks\":[]}";
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
    String out;serializeJson(doc,out);WiFi.scanDelete();return out;
}
void NetworkManager::connect(){
    if(!config_ || config_->ssid.length()==0)return;
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    WiFi.disconnect(false);
    delay(20);
    WiFi.begin(config_->ssid.c_str(),config_->password.c_str());
    uint32_t now=millis();
    wifiAttemptStartedAt_=now;
    lastReconnect_=now;
    wifiConnectInProgress_=true;
    if(wifiReconnectAttempt_<255)wifiReconnectAttempt_++;
    Serial.printf("[WiFi] connect attempt %u SSID=%s status=%s\n", wifiReconnectAttempt_, config_->ssid.c_str(), wifiStatusName(WiFi.status()));
}
void NetworkManager::printConnectionInfo(){
    Serial.printf(
        "[WiFi] connected SSID=%s IP=%s gateway=%s mask=%s RSSI=%d dBm attempts=%u\n",
        WiFi.SSID().c_str(),
        WiFi.localIP().toString().c_str(),
        WiFi.gatewayIP().toString().c_str(),
        WiFi.subnetMask().toString().c_str(),
        WiFi.RSSI(),
        wifiReconnectAttempt_
    );
}

void NetworkManager::printWifiStatus(int status,const char* context){
    Serial.printf("[WiFi] %s status=%s(%d) SSID=%s RSSI=%d\n",
        context,
        wifiStatusName(status),
        status,
        config_ ? config_->ssid.c_str() : "",
        WiFi.RSSI());
}

void NetworkManager::registerRoutes(){
    auto showPortal=[this](){
        String page=PAGE;
        page.replace("服务器暂时不可用时，设备会继续保持 Wi-Fi 并自动重连，不会自动进入配网；如需重新配网，请长按 BOOT 约 3 秒清除配置。", "开机后首次 3 分钟找不到服务器会进入配网；本次开机只要成功连上过服务器，之后断线只会自动重连，不会再进配网。也可长按 BOOT 约 3 秒手动重新配网。");
        page.replace("placeholder=\"设备名称\" value=\"机器鱼\"", "placeholder=\"留空则默认使用设备 MAC\"");
        page.replace("<form method=\"post\" action=\"/update\" enctype=\"multipart/form-data\"><input type=\"file\" name=\"firmware\" accept=\".bin\" required><button type=\"submit\">上传固件并重启</button></form>", "<p><a href=\"/ota\">打开 OTA 升级页面</a></p>");
        server_.sendHeader("Cache-Control","no-store");
        server_.send(200,"text/html; charset=utf-8",page);
    };
    server_.on("/",HTTP_GET,showPortal);
    const char* probes[]={"/generate_204","/gen_204","/hotspot-detect.html","/library/test/success.html","/connecttest.txt","/redirect","/ncsi.txt","/fwlink"};
    for(const char* path:probes)server_.on(path,HTTP_GET,showPortal);

    server_.on("/scan",HTTP_GET,[this](){
        server_.sendHeader("Cache-Control","no-store");server_.send(200,"application/json; charset=utf-8",scannedNetworksJson_);
    });

    server_.on("/ota",HTTP_GET,[this](){
        String page=OTA_PAGE;
        page.replace("{{VERSION}}",FIRMWARE_VERSION);
        server_.sendHeader("Cache-Control","no-store");
        server_.send(200,"text/html; charset=utf-8",page);
    });

    server_.on("/configure",HTTP_POST,[this](){
        DeviceConfig c=*config_; c.ssid=server_.arg("ssid");c.password=server_.arg("password");c.hasSavedWifi=true;c.controllerHost="";
        c.displayName=server_.arg("name");
        c.displayName.trim();
        if(!c.valid()){server_.send(400,"text/plain; charset=utf-8","配置无效，请检查所有字段");return;}
        Preferences cache;if(cache.begin("fish-endpoint",false)){cache.clear();cache.end();}
        if(!store_.save(c)){server_.send(500,"text/plain; charset=utf-8","保存失败");return;}
        policy_.provisioningFinished(millis());
        portalStarted_=false;
        dnsServer_.stop();
        server_.stop();
        server_.send(200,"text/plain; charset=utf-8","保存成功，设备正在重启");delay(300);ESP.restart();
    });
    server_.on("/update",HTTP_POST,[this](){
        if(!uploadAuthorized_){server_.send(401,"text/plain; charset=utf-8","OTA 密码错误");return;}
        if(!uploadOk_ || uploadFailed_ || Update.hasError()){server_.send(400,"text/plain; charset=utf-8","固件写入失败，请选择正确的 ESP32-C3 firmware.bin 后重试");return;}
        server_.send(200,"text/plain; charset=utf-8","固件更新成功，正在重启");delay(300);ESP.restart();
    },[this](){
        HTTPUpload& upload=server_.upload();
        if(upload.status==UPLOAD_FILE_START){
            uploadOk_=false;uploadFailed_=false;
            uploadAuthorized_=server_.authenticate("fish",FISH_OTA_PASSWORD);
            if(!uploadAuthorized_)return;
            String filename=upload.filename;filename.toLowerCase();
            if(upload.name!="update" || !filename.endsWith(".bin") || !Update.begin(UPDATE_SIZE_UNKNOWN)){uploadFailed_=true;}
        }else if(upload.status==UPLOAD_FILE_WRITE){
            if(uploadAuthorized_ && !uploadFailed_ && upload.totalSize==0 &&
               (upload.currentSize<14 || upload.buf[0]!=0xE9 || upload.buf[12]!=5 || upload.buf[13]!=0)){
                Update.abort();uploadFailed_=true;
            }
            if(uploadAuthorized_ && !uploadFailed_ && Update.write(upload.buf,upload.currentSize)!=upload.currentSize){Update.abort();uploadFailed_=true;}
        }else if(upload.status==UPLOAD_FILE_END){
            if(uploadAuthorized_ && !uploadFailed_ && upload.totalSize>0)uploadOk_=Update.end(true);
            if(uploadAuthorized_ && !uploadOk_){Update.abort();uploadFailed_=true;}
        }else if(upload.status==UPLOAD_FILE_ABORTED && uploadAuthorized_){Update.abort();uploadFailed_=true;uploadOk_=false;}
    });
    server_.onNotFound([this](){server_.sendHeader("Location","http://192.168.4.1/",true);server_.send(302,"text/plain; charset=utf-8","正在打开机器鱼配网页");});
}

void NetworkManager::startProvisioning(){
    if(portalStarted_)return;
    Serial.printf("[Recovery] setup AP %s at 192.168.4.1\n", provisioningApName().c_str());
    WiFi.disconnect(true);
    WiFi.mode(WIFI_STA);
    scannedNetworksJson_=scanNetworksJson();
    WiFi.mode(WIFI_AP_STA);
    String ap=provisioningApName();WiFi.softAP(ap.c_str());
    dnsServer_.setErrorReplyCode(DNSReplyCode::NoError);dnsServer_.start(53,"*",WiFi.softAPIP());
    registerRoutes();server_.begin();portalStarted_=true;
}

void NetworkManager::update(uint32_t nowMs,bool registered){
    if(portalStarted_){
        dnsServer_.processNextRequest();
        server_.handleClient();
        // Stay in AP mode until the user submits a new configuration. This
        // prevents an unreachable server from causing an AP/reconnect loop.
        return;
    }
    int status=WiFi.status();
    bool online=status==WL_CONNECTED;
    if(status!=lastWifiStatus_ || nowMs-lastWifiStatusLog_>=kWifiStatusLogIntervalMs){
        if(!online)printWifiStatus(status,"link check");
        lastWifiStatus_=status;
        lastWifiStatusLog_=nowMs;
    }
    if(!online && lastConnected_){
        wifiAttemptStartedAt_=nowMs;
        wifiConnectInProgress_=false;
        printWifiStatus(status,"connection lost");
    }
    policy_.setConnected(online,nowMs);
    policy_.setRegistered(registered,nowMs);

    // A factory-default device may open setup if the built-in Wi-Fi cannot be
    // reached. Saved-Wi-Fi devices get one boot-time server recovery window via
    // NetworkPolicy; after first registration, later controller loss only retries.
    if(!online && !hasSavedWifi_ && nowMs-wifiAttemptStartedAt_>=kWifiAttemptTimeoutMs){
        startProvisioning();
        return;
    }
    NetworkAction action=policy_.next(nowMs);
    if(action==NetworkAction::StartProvisioning){Serial.println("[Recovery] controller not found during boot window; starting setup portal");startProvisioning();return;}
    if(online){
        wifiConnectInProgress_=false;
        wifiReconnectAttempt_=0;
        if(!lastConnected_){
            printConnectionInfo();
            lastConnected_=true;
        }
        return;
    }
    lastConnected_=false;
    bool connectTimedOut=wifiConnectInProgress_ && nowMs-wifiAttemptStartedAt_>=kWifiAttemptTimeoutMs;
    if(connectTimedOut){
        printWifiStatus(status,"connect timeout; retrying");
        wifiConnectInProgress_=false;
        WiFi.disconnect(false);
    }
    if(action==NetworkAction::Connect){
        connect();
    }else if(action==NetworkAction::StartProvisioning){
        startProvisioning();
    }else if(!wifiConnectInProgress_ && nowMs-lastReconnect_>=kWifiReconnectIntervalMs){
        connect();
    }
}
