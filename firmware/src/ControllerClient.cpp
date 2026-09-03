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

ControllerClient::ControllerClient(MotionController& m,CommandProcessor& c,BatteryMonitor& b,AmbientLightMonitor& l,StatusLight& s,ConfigStore& store):motion_(m),commands_(c),battery_(b),ambientLight_(l),statusLight_(s),configStore_(store){}
void ControllerClient::begin(const DeviceConfig& c){
    config_=c;
    motion_.setNeutralCenter(config_.servoCenter);
    socket_.onEvent([this](WStype_t t,uint8_t*p,size_t n){onEvent(t,p,n);});
    socket_.setReconnectInterval(3000);
    endpointReady_=false;
    started_=false;
    registered_=false;
}
void ControllerClient::clearEndpoint(){endpointReady_=false;started_=false;registered_=false;}
void ControllerClient::setEndpoint(const IPAddress& host,uint16_t port){
    if(endpointReady_&&controllerIP_==host&&config_.controllerPort==port)return;
    if(started_)socket_.disconnect();controllerIP_=host;config_.controllerPort=port;endpointReady_=true;started_=false;registered_=false;
}
void ControllerClient::sendRegistration(const String& nonce){
    JsonDocument d;char mac[18];char proof[65];formatDeviceMac(mac);if(!computeIdentityProof("fish-websocket-v1",nonce.c_str(),proof))return;d["type"]="register";d["protocolVersion"]=1;d["deviceId"]=mac;d["proof"]=proof;d["name"]=config_.displayName;d["firmwareVersion"]=FIRMWARE_VERSION;d["ip"]=WiFi.localIP().toString();JsonArray a=d["capabilities"].to<JsonArray>();a.add("motion");a.add("ota");a.add("battery");a.add("status-rgb");a.add("ambient-light");String out;serializeJson(d,out);socket_.sendTXT(out);
}
void ControllerClient::sendState(const char* type){
    MotionSnapshot s=motion_.snapshot();BatteryReading battery=battery_.reading();AmbientLightReading light=ambientLight_.reading();uint32_t now=millis();char mac[18];formatDeviceMac(mac);JsonDocument d;d["type"]=type;d["deviceId"]=mac;d["controlSource"]=controlSource_;d["frequency"]=s.frequency;d["amplitude"]=s.amplitude;d["bias"]=s.bias;d["mode"]=(int)s.mode;d["rssi"]=WiFi.RSSI();d["ip"]=WiFi.localIP().toString();d["firmwareVersion"]=FIRMWARE_VERSION;d["uptimeMs"]=now;d["lastControlMs"]=lastControlMs_;d["stopReason"]=stopReason_;d["otaState"]=otaState_;d["rgbMode"]=statusLight_.manual()?"SOLID":"AUTO";d["rgbOrder"]=statusLight_.colorOrder();d["rgbRed"]=statusLight_.red();d["rgbGreen"]=statusLight_.green();d["rgbBlue"]=statusLight_.blue();d["rgbBrightness"]=statusLight_.brightness();if(battery.valid){d["batteryVoltage"]=roundf(battery.voltage*100.0f)/100.0f;d["batteryPercent"]=battery.percent;d["batterySampleAgeMs"]=now-battery.sampledAtMs;}d["lightSensorOnline"]=light.online;if(light.online)d["illuminanceLux"]=roundf(light.lux*100.0f)/100.0f;JsonArray addresses=d["i2cAddresses"].to<JsonArray>();for(uint8_t i=0;i<light.addressCount;i++)addresses.add(light.addresses[i]);String out;serializeJson(d,out);socket_.sendTXT(out);
}
void ControllerClient::sendResult(const String& id,bool success,const char* code,const String& message){JsonDocument d;MotionSnapshot s=motion_.snapshot();char mac[18];formatDeviceMac(mac);d["type"]="command.result";d["deviceId"]=mac;d["controlSource"]=controlSource_;d["requestId"]=id;d["success"]=success;d["code"]=code;d["message"]=message;JsonObject applied=d["applied"].to<JsonObject>();applied["deviceId"]=mac;applied["controlSource"]=controlSource_;applied["mode"]=(int)s.mode;applied["frequency"]=s.frequency;applied["amplitude"]=s.amplitude;applied["bias"]=s.bias;String out;serializeJson(d,out);socket_.sendTXT(out);}

void ControllerClient::runOta(const String& id,const String& expectedHash,size_t expectedSize){
    motion_.safeStop();stopReason_="OTA_REQUEST";otaState_="DOWNLOADING";sendState();
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
    if(command=="emergency.stop"){motion_.safeStop();stopReason_="EMERGENCY_STOP";lastControlMs_=millis();sendResult(id,true,"OK","紧急停止已执行");sendState();return;}
    if(command=="motion.set"){
        JsonObject payload=d["payload"].as<JsonObject>();
        float f=payload["frequency"]|motion_.snapshot().frequency;float a=payload["amplitude"]|motion_.snapshot().amplitude;bool hasBias=!payload["bias"].isNull();float bias=payload["bias"]|motion_.snapshot().bias;String mode=payload["mode"]|"stop";
        mode.toUpperCase();controlSource_=payload["controlSource"]|"";if(mode=="STOP")controlSource_="";if(mode=="CENTER"){
            motion_.centerAtBias(bias);
            config_.servoCenter=90.0f+bias;
            lastControlMs_=millis();
            stopReason_="CALIBRATION_CENTER";
            if(!configStore_.save(config_)){
                sendResult(id,false,"CONFIG_SAVE_FAILED","舵机中位已应用，但保存失败");
                sendState();
                return;
            }
            sendResult(id,true,"OK","Servo centered");sendState();return;
        }
        if(mode=="STOP"){
            if(hasBias) motion_.setBias(bias);
            motion_.safeStop();
            lastControlMs_=millis();
            stopReason_="MANUAL_STOP";
            sendResult(id,true,"OK","停止已执行");
            sendState();
            return;
        }
        motion_.setTuning(f,a);String result=commands_.process(mode=="FORWARD"?"FWD":mode);
        // Every accepted motion command must replace the previous steering
        // bias. Otherwise a forward command without an explicit bias can
        // continue using the previous left/right turn offset.
        if(result=="OK")motion_.setBias(hasBias ? bias : 0.0f);
        lastControlMs_=millis();stopReason_=mode=="STOP"?"MANUAL_STOP":"";sendResult(id,result=="OK",result=="OK"?"OK":"UNKNOWN_COMMAND",result);sendState();return;
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
    if(command=="ota.start"){
        String sha=d["payload"]["sha256"]|"";size_t size=d["payload"]["size"]|0U;
        if(sha.length()!=64||size==0){sendResult(id,false,"INVALID_FIRMWARE","固件信息无效");return;}
        String requestedName=d["payload"]["name"]|"";requestedName.trim();
        if(requestedName.length()>0&&requestedName!=config_.displayName){
            config_.displayName=requestedName;
            if(!configStore_.save(config_)){sendResult(id,false,"CONFIG_SAVE_FAILED","设备名称保存失败");return;}
        }
        runOta(id,sha,size);return;
    }
    if(command=="ota.cancel"){otaState_="IDLE";sendResult(id,true,"OK","OTA 预留任务已取消");sendState();return;}
    sendResult(id,false,"UNKNOWN_COMMAND","未知命令");
}
void ControllerClient::onEvent(WStype_t type,uint8_t* payload,size_t length){
    if(type==WStype_CONNECTED){
        registered_=false;
        return;
    }
    if(type==WStype_DISCONNECTED){
        clearEndpoint();motion_.safeStop();stopReason_="CONTROLLER_DISCONNECTED";return;
    }
    if(type!=WStype_TEXT)return;
    JsonDocument d;if(deserializeJson(d,payload,length))return;String messageType=d["type"]|"";
    String nonce;if(readAuthChallenge(d,nonce)){sendRegistration(nonce);return;}
    if(messageType=="register.result"&&(bool)(d["success"]|false)){registered_=true;lastHeartbeat_=millis();return;}
    if(!registered_)return;
    if(messageType=="heartbeat"){lastHeartbeat_=millis();return;}
    if(messageType=="command")handleCommand(d);
}
void ControllerClient::update(uint32_t nowMs,bool online){
    if(!online){if(started_)socket_.disconnect();clearEndpoint();motion_.safeStop();return;}
    if(!endpointReady_)return;
    if(!started_){socket_.begin(controllerIP_.toString().c_str(),config_.controllerPort,"/ws/device");started_=true;}
    socket_.loop();
    if(registered_&&hasElapsed(nowMs,lastHeartbeat_,CONTROLLER_HEARTBEAT_TIMEOUT_MS)){registered_=false;motion_.safeStop();stopReason_="CONTROLLER_TIMEOUT";socket_.disconnect();return;}
    if(registered_&&hasElapsed(nowMs,lastReport_,1000)){lastReport_=nowMs;sendState("heartbeat");}
}
