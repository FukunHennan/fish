#include "ConfigStore.h"
#include "FactoryWifi.h"
#include "ConfigPersistence.h"
#include "DeviceIdentity.h"
#include <Preferences.h>

bool ConfigStore::load(DeviceConfig& c) {
    Preferences p; if (!p.begin("fishcfg", true)) return false;
    c.ssid=p.getString("ssid"); c.password=p.getString("pass"); c.hasSavedWifi=c.ssid.length() > 0; c.controllerHost=p.getString("host");
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
    DeviceConfig persisted = c;
    // Factory Wi-Fi is a compile-time fallback, not a user provisioning
    // record. Keep NVS empty until the AP form explicitly saves credentials.
    if (!c.hasSavedWifi) {
        persisted.ssid = "";
        persisted.password = "";
    }
    bool ok=writeAndVerifyDeviceConfig(p,persisted);p.end();return ok;
}
void ConfigStore::clear() { Preferences p; if(p.begin("fishcfg",false)){p.clear();p.end();} Preferences cache;if(cache.begin("fish-endpoint",false)){cache.clear();cache.end();} }
