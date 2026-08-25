#include "NetworkManager.h"
#include "DeviceIdentity.h"
#include "CaptivePortalRoutes.h"
#include <WiFi.h>

static const char PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>机器鱼配网</title><style>body{font-family:sans-serif;max-width:420px;margin:30px auto;padding:16px;color:#172033}.tip{background:#eef6ff;padding:12px;border-radius:8px;margin-bottom:14px}input,button{width:100%;box-sizing:border-box;padding:12px;margin:6px 0}button{background:#1677ff;color:white;border:0;border-radius:6px}</style></head><body><h2>机器鱼配网</h2><div class="tip">只需填写 Wi-Fi。保存重启后，设备会自动发现同一局域网中的控制电脑。</div><form method="post" action="/configure"><input name="ssid" placeholder="Wi-Fi 名称" required><input type="password" name="password" placeholder="Wi-Fi 密码"><input name="name" placeholder="设备名称" value="机器鱼"><button>保存并重启</button></form></body></html>)HTML";

NetworkManager::NetworkManager(ConfigStore& store):store_(store){}
void NetworkManager::begin(DeviceConfig& config){config_=&config; policy_.begin(config.valid(),millis());}
bool NetworkManager::connected() const{return WiFi.status()==WL_CONNECTED;}
bool NetworkManager::provisioning() const{return portalStarted_;}
void NetworkManager::connect(){WiFi.mode(WIFI_STA);WiFi.begin(config_->ssid.c_str(),config_->password.c_str());lastReconnect_=millis();}
void NetworkManager::registerRoutes(){
    auto showPortal=[this](){server_.sendHeader("Cache-Control","no-store");server_.send(200,"text/html; charset=utf-8",PAGE);};
    server_.on("/",HTTP_GET,showPortal);
    const char* probes[]={"/generate_204","/gen_204","/hotspot-detect.html","/library/test/success.html","/connecttest.txt","/redirect","/ncsi.txt","/fwlink"};
    for(const char* path:probes)server_.on(path,HTTP_GET,showPortal);
    server_.on("/configure",HTTP_POST,[this](){
        DeviceConfig c; c.ssid=server_.arg("ssid");c.password=server_.arg("password");c.displayName=server_.arg("name");
        if(!c.valid()){server_.send(400,"text/plain; charset=utf-8","配置无效，请检查所有字段");return;}
        if(!store_.save(c)){server_.send(500,"text/plain; charset=utf-8","保存失败");return;}
        server_.send(200,"text/plain; charset=utf-8","保存成功，设备正在重启");delay(300);ESP.restart();
    });
    server_.onNotFound([this](){server_.sendHeader("Location","http://192.168.4.1/",true);server_.send(302,"text/plain; charset=utf-8","正在打开机器鱼配网页");});
}
void NetworkManager::startProvisioning(){
    WiFi.disconnect(true);WiFi.mode(WIFI_AP);String ap=provisioningApName();WiFi.softAP(ap.c_str());
    dnsServer_.setErrorReplyCode(DNSReplyCode::NoError);dnsServer_.start(53,"*",WiFi.softAPIP());
    registerRoutes();server_.begin();portalStarted_=true;
    Serial.printf("配网热点: %s，打开 http://192.168.4.1\n",ap.c_str());
}
void NetworkManager::update(uint32_t nowMs){
    if(portalStarted_){dnsServer_.processNextRequest();server_.handleClient();return;}
    bool online=connected();policy_.setConnected(online,nowMs);
    if(online)return;
    NetworkAction action=policy_.next(nowMs);
    if(action==NetworkAction::Connect)connect(); else if(action==NetworkAction::StartProvisioning)startProvisioning();
    else if(nowMs-lastReconnect_>=15000)connect();
}
