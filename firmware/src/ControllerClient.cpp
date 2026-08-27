#include "ControllerClient.h"
#include "DeviceIdentity.h"
#include "AuthProtocol.h"
#include "ControlTiming.h"
#include "AppConfig.h"
#include <ArduinoJson.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>

ControllerClient::ControllerClient(MotionController& m,CommandProcessor& c,VisualController& v,BatteryMonitor& b,AmbientLightMonitor& l,StatusLight& s):motion_(m),commands_(c),visual_(v),battery_(b),ambientLight_(l),statusLight_(s){}
void ControllerClient::begin(const DeviceConfig& c){config_=c;socket_.onEvent([this](WStype_t t,uint8_t*p,size_t n){onEvent(t,p,n);});socket_.setReconnectInterval(3000);}
void ControllerClient::setEndpoint(const IPAddress& host,uint16_t port){
    if(endpointReady_&&controllerIP_==host&&config_.controllerPort==port)return;
    if(started_)socket_.disconnect();controllerIP_=host;config_.controllerPort=port;endpointReady_=true;started_=false;registered_=false;
}
void ControllerClient::sendRegistration(const String& nonce){
    JsonDocument d;char mac[18];char proof[65];formatDeviceMac(mac);if(!computeIdentityProof("fish-websocket-v1",nonce.c_str(),proof))return;d["type"]="register";d["protocolVersion"]=1;d["deviceId"]=mac;d["proof"]=proof;d["name"]=config_.displayName;d["firmwareVersion"]=FIRMWARE_VERSION;d["ip"]=WiFi.localIP().toString();JsonArray a=d["capabilities"].to<JsonArray>();a.add("motion");a.add("ota");a.add("battery");a.add("status-rgb");a.add("ambient-light");String out;serializeJson(d,out);socket_.sendTXT(out);
}
void ControllerClient::sendState(const char* type){
    MotionSnapshot s=motion_.snapshot();BatteryReading battery=battery_.reading();AmbientLightReading light=ambientLight_.reading();uint32_t now=millis();JsonDocument d;d["type"]=type;d["frequency"]=s.frequency;d["amplitude"]=s.amplitude;d["bias"]=s.bias;d["mode"]=(int)s.mode;d["rssi"]=WiFi.RSSI();d["ip"]=WiFi.localIP().toString();d["firmwareVersion"]=FIRMWARE_VERSION;d["uptimeMs"]=now;d["lastControlMs"]=lastControlMs_;d["stopReason"]=stopReason_;d["controlSource"]=visual_.active()?"VISION":"MANUAL";d["visionActive"]=visual_.active();d["visionSessionId"]=visual_.sessionId();d["visionSequence"]=visual_.lastSequence();d["otaState"]=otaState_;d["rgbMode"]=statusLight_.manual()?"SOLID":"AUTO";d["rgbOrder"]=statusLight_.colorOrder();d["rgbRed"]=statusLight_.red();d["rgbGreen"]=statusLight_.green();d["rgbBlue"]=statusLight_.blue();d["rgbBrightness"]=statusLight_.brightness();if(battery.valid){d["batteryVoltage"]=roundf(battery.voltage*100.0f)/100.0f;d["batteryPercent"]=battery.percent;d["batterySampleAgeMs"]=now-battery.sampledAtMs;}d["lightSensorOnline"]=light.online;if(light.online)d["illuminanceLux"]=roundf(light.lux*100.0f)/100.0f;JsonArray addresses=d["i2cAddresses"].to<JsonArray>();for(uint8_t i=0;i<light.addressCount;i++)addresses.add(light.addresses[i]);String out;serializeJson(d,out);socket_.sendTXT(out);
}
void ControllerClient::sendResult(const String& id,bool success,const char* code,const String& message){JsonDocument d;MotionSnapshot s=motion_.snapshot();d["type"]="command.result";d["requestId"]=id;d["success"]=success;d["code"]=code;d["message"]=message;JsonObject applied=d["applied"].to<JsonObject>();applied["mode"]=(int)s.mode;applied["frequency"]=s.frequency;applied["amplitude"]=s.amplitude;applied["bias"]=s.bias;String out;serializeJson(d,out);socket_.sendTXT(out);}

void ControllerClient::runOta(const String& id,const String& expectedHash,size_t expectedSize){
    motion_.safeStop();visual_.stop();stopReason_="OTA_REQUEST";otaState_="DOWNLOADING";sendState();
    HTTPClient http;String url="http://"+controllerIP_.toString()+":"+String(config_.controllerPort)+"/api/firmware/current.bin";
    if(!http.begin(url)||http.GET()!=HTTP_CODE_OK){otaState_="FAILED";sendResult(id,false,"OTA_DOWNLOAD_FAILED","无法下载固件");http.end();sendState();return;}
    int total=http.getSize();if(total<=0||(expectedSize>0&&(size_t)total!=expectedSize)){otaState_="FAILED";sendResult(id,false,"OTA_SIZE_MISMATCH","固件大小不匹配");http.end();sendState();return;}
    if(!Update.begin((size_t)total)){otaState_="FAILED";sendResult(id,false,"OTA_NO_SPACE","OTA 分区空间不足");http.end();sendState();return;}
    mbedtls_sha256_context sha;mbedtls_sha256_init(&sha);mbedtls_sha256_starts_ret(&sha,0);WiFiClient* stream=http.getStreamPtr();uint8_t buffer[1024];size_t written=0;
    while(http.connected()&&written<(size_t)total){size_t available=stream->available();if(!available){delay(1);continue;}int count=stream->readBytes(buffer,min(available,sizeof(buffer)));if(count<=0)break;mbedtls_sha256_update_ret(&sha,buffer,count);if(Update.write(buffer,count)!=(size_t)count)break;written+=count;}
    unsigned char digest[32];mbedtls_sha256_finish_ret(&sha,digest);mbedtls_sha256_free(&sha);http.end();char actual[65];for(size_t i=0;i<32;i++)snprintf(actual+i*2,3,"%02x",digest[i]);actual[64]='\0';
    if(written!=(size_t)total||!expectedHash.equalsIgnoreCase(actual)){Update.abort();otaState_="FAILED";sendResult(id,false,"OTA_HASH_MISMATCH","固件校验失败");sendState();return;}
    if(!Update.end(true)){otaState_="FAILED";sendResult(id,false,"OTA_INSTALL_FAILED",Update.errorString());sendState();return;}
    otaState_="REBOOTING";sendResult(id,true,"OK","固件升级完成，正在重启");sendState();delay(300);ESP.restart();
}

void ControllerClient::handleCommand(JsonDocument& d){
    String id=d["requestId"]|"";String command=d["command"]|"";if(id.length()==0){sendResult(id,false,"MISSING_REQUEST_ID","缺少请求 ID");return;}
    if(command=="motion.set"){
        if(visual_.active()){sendResult(id,false,"CONTROL_LOCKED","视觉控制运行中");return;}
        float f=d["payload"]["frequency"]|motion_.snapshot().frequency;float a=d["payload"]["amplitude"]|motion_.snapshot().amplitude;float bias=d["payload"]["bias"]|0.0f;String mode=d["payload"]["mode"]|"stop";
        if(!motion_.setTuning(f,a)||!motion_.setBias(bias)){sendResult(id,false,"INVALID_PARAMETER","运动参数越界");return;}mode.toUpperCase();String result=commands_.process(mode=="FORWARD"?"FWD":mode);lastControlMs_=millis();stopReason_=mode=="STOP"?"MANUAL_STOP":"";sendResult(id,result=="OK",result=="OK"?"OK":"UNKNOWN_COMMAND",result);sendState();return;
    }
    if(command=="vision.start"){String session=d["payload"]["sessionId"]|"";motion_.safeStop();if(!visual_.start(session.c_str(),millis())){sendResult(id,false,"INVALID_SESSION","视觉会话 ID 无效");return;}stopReason_="";lastControlMs_=millis();sendResult(id,true,"OK","视觉会话已启动");sendState();return;}
    if(command=="vision.calibrate.forward"){
        if(!visual_.active()){sendResult(id,false,"VISION_NOT_ACTIVE","Vision session is not active");return;}
        motion_.setTuning(2.0f,22.0f);commands_.process("FWD");calibrationStopAtMs_=millis()+1200;lastControlMs_=millis();stopReason_="CAL_FORWARD";sendResult(id,true,"OK","Forward calibration started");sendState();return;
    }
    if(command=="vision.update"){
        VisualInput input{d["payload"]["sequence"]|0U,d["payload"]["crossTrackError"]|0.0f,d["payload"]["headingErrorDeg"]|0.0f,d["payload"]["distanceToTarget"]|0.0f,d["payload"]["speed"]|0.0f,d["payload"]["curvature"]|0.0f,d["payload"]["brake"]|false};String session=d["payload"]["sessionId"]|"";VisualOutput output;
        if(!visual_.update(session.c_str(),input,millis(),output)){sendResult(id,false,"STALE_VISION_COMMAND","会话错误或视觉序号无效");return;}if(output.stop){motion_.safeStop();stopReason_="VISION_BRAKE";}else motion_.applyVisual(output.frequency,output.amplitude,output.bias);lastControlMs_=millis();sendResult(id,true,"OK","视觉指令已应用");return;
    }
    if(command=="vision.stop"){visual_.stop();motion_.safeStop();stopReason_="VISION_STOP";lastControlMs_=millis();sendResult(id,true,"OK","视觉会话已停止");sendState();return;}
    if(command=="pid.set"){
        VisualPidParameters p=visual_.parameters();p.crossKp=d["payload"]["crossKp"]|p.crossKp;p.crossKi=d["payload"]["crossKi"]|p.crossKi;p.crossKd=d["payload"]["crossKd"]|p.crossKd;p.headingKp=d["payload"]["headingKp"]|p.headingKp;p.curveFeedForward=d["payload"]["curveFeedForward"]|p.curveFeedForward;p.maxBias=d["payload"]["maxBias"]|p.maxBias;p.timeoutMs=d["payload"]["timeoutMs"]|p.timeoutMs;bool ok=visual_.setParameters(p);sendResult(id,ok,ok?"OK":"INVALID_PID",ok?"PID 参数已更新":"PID 参数无效");return;
    }
    if(command=="rgb.set"){
        String mode=d["payload"]["mode"]|"AUTO";mode.toUpperCase();
        String order=d["payload"]["order"]|statusLight_.colorOrder();if(!statusLight_.setColorOrder(order)){sendResult(id,false,"INVALID_RGB_ORDER","Unsupported RGB color order");return;}
        int brightness=d["payload"]["brightness"]|STATUS_LED_BRIGHTNESS;if(brightness<1||brightness>255){sendResult(id,false,"INVALID_RGB","RGB brightness out of range");return;}
        if(mode=="AUTO"){statusLight_.clearManual(brightness);sendResult(id,true,"OK","RGB automatic brightness applied");sendState();return;}
        int red=d["payload"]["red"]|-1,green=d["payload"]["green"]|-1,blue=d["payload"]["blue"]|-1;
        if(mode!="SOLID"||red<0||red>255||green<0||green>255||blue<0||blue>255){sendResult(id,false,"INVALID_RGB","RGB parameter out of range");return;}
        statusLight_.setManualColor(red,green,blue,brightness);sendResult(id,true,"OK","RGB color applied");sendState();return;
    }
    if(command=="ota.start"){String sha=d["payload"]["sha256"]|"";size_t size=d["payload"]["size"]|0U;if(sha.length()!=64||size==0){sendResult(id,false,"INVALID_FIRMWARE","固件信息无效");return;}runOta(id,sha,size);return;}
    if(command=="ota.cancel"){otaState_="IDLE";sendResult(id,true,"OK","OTA 预留任务已取消");sendState();return;}
    sendResult(id,false,"UNKNOWN_COMMAND","未知命令");
}
void ControllerClient::onEvent(WStype_t type,uint8_t* payload,size_t length){
    if(type==WStype_CONNECTED){registered_=false;return;}
    if(type==WStype_DISCONNECTED){registered_=false;visual_.stop();motion_.safeStop();stopReason_="CONTROLLER_DISCONNECTED";return;}
    if(type!=WStype_TEXT)return;
    JsonDocument d;if(deserializeJson(d,payload,length))return;String messageType=d["type"]|"";
    String nonce;if(readAuthChallenge(d,nonce)){sendRegistration(nonce);return;}
    if(messageType=="register.result"&&(bool)(d["success"]|false)){registered_=true;lastHeartbeat_=millis();return;}
    if(!registered_)return;
    if(messageType=="heartbeat"){lastHeartbeat_=millis();return;}
    if(messageType=="command")handleCommand(d);
}
void ControllerClient::update(uint32_t nowMs,bool online){
    if(!online){if(started_){socket_.disconnect();started_=false;}motion_.safeStop();return;}
    if(!endpointReady_)return;
    if(!started_){socket_.begin(controllerIP_.toString().c_str(),config_.controllerPort,"/ws/device");started_=true;}
    socket_.loop();
    // WebSocket callbacks above may start a visual session using a newer millis()
    // value than the loop timestamp supplied by the caller. Refresh the clock to
    // avoid unsigned underflow immediately timing out the new session.
    const uint32_t commandNowMs=millis();
    if(calibrationStopAtMs_!=0&&(int32_t)(commandNowMs-calibrationStopAtMs_)>=0){calibrationStopAtMs_=0;visual_.stop();motion_.safeStop();stopReason_="CAL_FORWARD_DONE";sendState();}
    if(calibrationStopAtMs_==0&&visual_.timedOut(commandNowMs)){visual_.stop();motion_.safeStop();stopReason_="VISION_TIMEOUT";sendState();}
    if(registered_&&hasElapsed(nowMs,lastHeartbeat_,CONTROLLER_HEARTBEAT_TIMEOUT_MS)){registered_=false;visual_.stop();motion_.safeStop();stopReason_="CONTROLLER_TIMEOUT";socket_.disconnect();return;}
    if(registered_&&hasElapsed(nowMs,lastReport_,1000)){lastReport_=nowMs;sendState("heartbeat");}
}
