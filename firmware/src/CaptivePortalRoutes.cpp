#include "CaptivePortalRoutes.h"
#include <string.h>

bool isCaptiveProbePath(const char* path) {
    static const char* paths[] = {
        "/generate_204",
        "/gen_204",
        "/hotspot-detect.html",
        "/library/test/success.html",
        "/connecttest.txt",
        "/redirect",
        "/ncsi.txt",
        "/fwlink"
    };
    for (const char* candidate : paths) {
        if (strcmp(path, candidate) == 0) return true;
    }
    return false;
}

