#include "ConfigStore.h"
#include "FactoryWifi.h"
#include "ConfigPersistence.h"
#include "DeviceIdentity.h"
#include <Preferences.h>

bool ConfigStore::load(DeviceConfig& c) {
    Preferences p; if (!p.begin("fishcfg", true)) return false;
    c.ssid=p.getString("ssid"); c.password=p.getString("pass"); c.controllerHost=p.getString("host");
    c.controllerPort=p.getUShort("port",8081); c.displayName=p.getString("name","");
    if(c.displayName.length()==0){
        char mac[18];
        formatDeviceMac(mac);
        c.displayName=String(mac);
    }
    c.servoCenter=p.getFloat("center",90.0f); p.end();
    applyFactoryWifiDefaults(c);
    return c.valid();
}
bool ConfigStore::save(const DeviceConfig& c) {
    if (!c.valid()) return false; Preferences p; if (!p.begin("fishcfg",false)) return false;
    bool ok=writeAndVerifyDeviceConfig(p,c);p.end();return ok;
}
void ConfigStore::clear() { Preferences p; if(p.begin("fishcfg",false)){p.clear();p.end();} Preferences cache;if(cache.begin("fish-endpoint",false)){cache.clear();cache.end();} }
