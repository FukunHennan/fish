#pragma once

template <typename PreferencesLike, typename ConfigLike>
bool writeAndVerifyDeviceConfig(PreferencesLike& preferences, const ConfigLike& config) {
    preferences.putString("ssid", config.ssid);
    preferences.putString("pass", config.password);
    preferences.putString("host", config.controllerHost);
    preferences.putUShort("port", config.controllerPort);
    preferences.putString("name", config.displayName);
    return preferences.getString("ssid") == config.ssid &&
           preferences.getString("pass") == config.password &&
           preferences.getString("host") == config.controllerHost &&
           preferences.getUShort("port", 0) == config.controllerPort &&
           preferences.getString("name") == config.displayName;
}
