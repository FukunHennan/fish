#pragma once

#if __has_include("FactoryWifi.local.h")
#include "FactoryWifi.local.h"
#endif

#ifndef FISH_FACTORY_WIFI_SSID
#define FISH_FACTORY_WIFI_SSID ""
#endif

#ifndef FISH_FACTORY_WIFI_PASSWORD
#define FISH_FACTORY_WIFI_PASSWORD ""
#endif

constexpr const char* FACTORY_WIFI_SSID = FISH_FACTORY_WIFI_SSID;
constexpr const char* FACTORY_WIFI_PASSWORD = FISH_FACTORY_WIFI_PASSWORD;

template <typename Config>
void applyFactoryWifiDefaults(Config& config) {
    if (config.ssid.length() == 0) {
        config.ssid = FACTORY_WIFI_SSID;
        config.password = FACTORY_WIFI_PASSWORD;
    }
}
