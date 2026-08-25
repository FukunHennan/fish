#include "VisualController.h"
#include <algorithm>
#include <cmath>

static float clampValue(float value,float low,float high){return std::max(low,std::min(high,value));}

bool VisualController::start(const char* id,uint32_t nowMs){
    if(id==nullptr||id[0]=='\0')return false;sessionId_=id;active_=true;receivedUpdate_=false;lastSequence_=0;lastUpdateMs_=nowMs;integral_=0;previousError_=0;return true;
}
void VisualController::stop(){active_=false;sessionId_.clear();integral_=0;}
bool VisualController::setParameters(const VisualPidParameters& p){
    if(p.crossKp<0||p.crossKi<0||p.crossKd<0||p.headingKp<0||p.curveFeedForward<0||p.maxBias<=0||p.maxBias>45||p.cruiseFrequency<0.3f||p.cruiseFrequency>5||p.cruiseAmplitude<0||p.cruiseAmplitude>50||p.stopDistance<0||p.slowDistance<=p.stopDistance||p.timeoutMs<200||p.timeoutMs>2000)return false;parameters_=p;return true;
}
bool VisualController::update(const char* id,const VisualInput& in,uint32_t nowMs,VisualOutput& out){
    if(!active_||id==nullptr||sessionId_!=id||(receivedUpdate_&&in.sequence<=lastSequence_))return false;
    float dt=receivedUpdate_?clampValue((nowMs-lastUpdateMs_)/1000.0f,0.01f,0.5f):0.1f;
    integral_=clampValue(integral_+in.crossTrackError*dt,-2.0f,2.0f);float derivative=(in.crossTrackError-previousError_)/dt;
    float steering=parameters_.crossKp*in.crossTrackError+parameters_.crossKi*integral_+parameters_.crossKd*derivative+parameters_.headingKp*in.headingErrorDeg+parameters_.curveFeedForward*in.curvature;
    float scale=clampValue(in.distanceToTarget/parameters_.slowDistance,0.25f,1.0f);out.stop=in.brake&&in.distanceToTarget<=parameters_.stopDistance;
    out.frequency=out.stop?0.0f:clampValue(parameters_.cruiseFrequency*scale,0.3f,5.0f);out.amplitude=out.stop?0.0f:clampValue(parameters_.cruiseAmplitude*scale,6.0f,50.0f);out.bias=out.stop?0.0f:clampValue(steering,-parameters_.maxBias,parameters_.maxBias);
    lastSequence_=in.sequence;lastUpdateMs_=nowMs;previousError_=in.crossTrackError;receivedUpdate_=true;return true;
}
bool VisualController::timedOut(uint32_t nowMs)const{return active_&&nowMs-lastUpdateMs_>=parameters_.timeoutMs;}

