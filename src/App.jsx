import React from 'react';
import {
  Layout,
  Button,
  Modal,
  Icon,
  notification,
  Card,
  Spin,
  Tooltip,
  message,
} from 'antd';
const { confirm } = Modal;
const { Header, Content, Sider } = Layout;
import MediaSettings from './settings';
import ChatFeed from './chat/index';
import Message from './chat/message';
import bLogo from '../public/100ms-logo-on-black.png';
import { AppContextProvider, AppContext } from "./stores/AppContext";
import '../styles/css/app.scss';

import LoginForm from './LoginForm';
import Conference from './Conference';
import { HMSClient, HMSPeer, HMSClientConfig } from '@100mslive/hmsvideo-web';
import { ENVS, ROLES } from './constants';
import { dependencies } from '../package.json';
import { getRequest } from './utils';

const sdkVersion = dependencies['@100mslive/hmsvideo-web'].substring(1);
console.info(`Using hmsvideo-web SDK version ${sdkVersion}`);

async function getToken({ room_id, user_name, role = 'guest', env }) {
  const endpoint = process.env.TOKEN_ENDPOINT;
  const { token } = await fetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ room_id, user_name, env, role }),
  })
    .then(response => response.json())
    .catch(err => console.log('Error client token: ', err));
  return token;
}

class OldAppUI extends React.Component {
  constructor(props) {
    super(props);
    this.client = null;
    this.isConnected = false;
    this.state = {
      login: false,
      loading: false,
      localAudioEnabled: true,
      localVideoEnabled: true,
      screenSharingEnabled: false,
      collapsed: true,
      isFullScreen: false,
      vidFit: false,
      loginInfo: {},
      messages: [],
    };

    this._settings = {
      selectedAudioDevice: '',
      selectedVideoDevice: '',
      resolution: 'qvga',
      bandwidth: 256,
      codec: 'vp8',
      frameRate: 20,
      isDevMode: true,
    };

    let settings = props.appSettings;
    if (settings.codec !== undefined) {
      this._settings = { ...this._settings, ...settings };
    }
  }

  _cleanUp = async () => {
    window.history.pushState(
      {},
      '100ms',
      `${window.location.protocol}//${window.location.host}`
    );
    await this.conference.cleanUp();
    await this.client.disconnect();
    this.client = null;
    this.isConnected = false;
    this.setState({
      login: false,
    });
  };

  _notification = (message, description) => {
    notification.info({
      message: message,
      description: description,
      placement: 'bottomRight',
    });
  };

  _createClient = async ({ userName, env, roomId, role }) => {
    let url = `wss://${env}.${process.env.SFU_HOST || window.location.host}`;
    let authToken = await getToken({
      env,
      room_id: roomId,
      user_name: userName,
      role,
    });

    console.log(`%cTOKEN IS: ${authToken}`, 'color: orange');

    console.log('Websocket URL', url);

    try {
      let peer = new HMSPeer(userName, authToken);

      let config = new HMSClientConfig({
        endpoint: url,
      });

      return new HMSClient(peer, config);
    } catch (err) {
      console.error('ERROR: ', err);
      alert('Invalid token');
    }
  };

  _handleJoin = async values => {
    this.setState({ loading: true });
    let settings = this._settings;
    this.roomName = values.roomName;
    this.roomId = values.roomId;
    this.role = values.role;
    this.hideMessage = () => {};
    settings.selectedVideoDevice = values.selectedVideoDevice;
    settings.selectedAudioDevice = values.selectedAudioDevice;
    //TODO this should reflect in initialization as well

    ![ROLES.LIVE_RECORD, ROLES.VIEWER].includes(this.role) &&
      this._onMediaSettingsChanged(
        settings.selectedAudioDevice,
        settings.selectedVideoDevice,
        settings.resolution,
        settings.bandwidth,
        settings.codec,
        settings.frameRate,
        settings.isDevMode
      );

    let client = await this._createClient({
      userName: values.displayName,
      env: values.env,
      roomId: values.roomId,
      role: values.role,
    });
    client.connect().catch(error => {
      alert(error.message);
    });

    window.onunload = async () => {
      await this._cleanUp();
    };

    client.on('peer-join', (room, peer) => {
      this._notification('Peer Join', `peer => ${peer.name} joined ${room}!`);
    });

    client.on('peer-leave', (room, peer) => {
      this._notification('Peer Leave', `peer => ${peer.name} left ${room}!`);
    });

    client.on('connect', () => {
      console.log('on connect called');
      if (this.isConnected) return;
      console.log('connected!');
      this._handleTransportOpen(values);
    });

    client.on('disconnect', () => {
      console.log('disconnected!');
      this.setState({
        loading: false,
      });
    });

    client.on('stream-add', (room, streamInfo) => {
      console.log('stream-add %s,%s!', room, streamInfo.mid);
    });

    client.on('stream-remove', (room, streamInfo) => {
      console.log(`stream-remove: ${room}, ${streamInfo.mid}`);
    });

    client.on('broadcast', (room, peer, message) => {
      console.log('broadcast: ', room, peer.name, message);
      this._onMessageReceived(peer.name, message);
    });

    client.on('disconnected', async () => {
      console.log(`%c[APP] TEARING DOWN`, 'color:#fc0');
      location.reload();
    });

    this.client = client;
  };

  _handleTransportOpen = async values => {
    this.isConnected = true;
    this.props.setLoginInfo(values);
    try {
      await this.client.join(values.roomId).catch(error => {
        console.log('JOIN ERROR:', error);
      });
      let redirectURL = `${window.location.protocol}//${window.location.host}/?room=${values.roomId}&env=${values.env}&role=${values.role}`;

      window.history.pushState({}, '100ms', redirectURL);

      this.setState({
        login: true,
        loading: false,
        loginInfo: values,
        localVideoEnabled: !values.audioOnly,
        localAudioEnabled: !values.videoOnly,
      });

      console.log('VALUES:', values);

      this._notification(
        'Connected!',
        `Welcome to the ${values.roomName || '100ms'} room => ${values.roomId}`
      );

      // Local video & audio are disabled for the 'live-record'
      // and 'viewer' roles. Their local stream is also not published.
      if (![ROLES.LIVE_RECORD, ROLES.VIEWER].includes(values.role)) {
        await this.conference.handleLocalStream();
      }
    } catch (error) {
      console.error('HANDLE THIS ERROR: ', error);
    }
  };

  _handleLeave = async () => {
    let this2 = this;
    confirm({
      title: 'Leave Now?',
      content: 'Do you want to leave the room?',
      async onOk() {
        await this2._cleanUp();
        this2.setState({ login: false });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  _handleAudioTrackEnabled = enabled => {
    this.setState({
      localAudioEnabled: enabled,
    });
    this.conference.muteMediaTrack('audio', enabled);
  };

  _handleVideoTrackEnabled = enabled => {
    this.setState({
      localVideoEnabled: enabled,
    });
    this.conference.muteMediaTrack('video', enabled);
  };

  _handleScreenSharing = enabled => {
    this.setState({
      screenSharingEnabled: enabled,
    });
    this.conference.handleScreenSharing(enabled);
  };

  _onRef = ref => {
    this.conference = ref;
  };

  _openOrCloseLeftContainer = collapsed => {
    this.setState({
      collapsed: collapsed,
    });
  };

  _onVidFitClickHandler = () => {
    this.setState({
      vidFit: !this.state.vidFit,
    });
  };

  _onFullScreenClickHandler = () => {
    let docElm = document.documentElement;

    if (this._fullscreenState()) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.webkitCancelFullScreen) {
        document.webkitCancelFullScreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      }

      this.setState({ isFullScreen: false });
    } else {
      if (docElm.requestFullscreen) {
        docElm.requestFullscreen();
      }
      //FireFox
      else if (docElm.mozRequestFullScreen) {
        docElm.mozRequestFullScreen();
      }
      //Chrome等
      else if (docElm.webkitRequestFullScreen) {
        docElm.webkitRequestFullScreen();
      }
      //IE11
      else if (elem.msRequestFullscreen) {
        elem.msRequestFullscreen();
      }

      this.setState({ isFullScreen: true });
    }
  };

  _fullscreenState = () => {
    return (
      document.fullscreen ||
      document.webkitIsFullScreen ||
      document.mozFullScreen ||
      false
    );
  };

  _onMediaSettingsChanged = (
    selectedAudioDevice,
    selectedVideoDevice,
    resolution,
    bandwidth,
    codec,
    frameRate,
    isDevMode,
    reloadPage = false
  ) => {
    this._settings = {
      selectedAudioDevice,
      selectedVideoDevice,
      resolution,
      bandwidth,
      codec,
      frameRate,
      isDevMode,
    };
    this.props.setAppSettings(this._settings);
    const constraints = {
      frameRate: frameRate,
      bitrate: bandwidth,
      resolution: resolution,
      advancedMediaConstraints: {
        audio: {
          deviceId: selectedAudioDevice,
        },
        video: {
          deviceId: selectedVideoDevice,
        },
      },
    };
    if (reloadPage) {
      this.client &&
        this.client.applyConstraints(constraints, this.client.local);
    }
  };

  _onMessageReceived = (from, message) => {
    console.log('Received message:' + from + ':' + message);
    let messages = this.state.messages;
    let uid = 1;
    messages.push(new Message({ id: uid, message: message, senderName: from }));
    let hasUnreadMessages = false;
    if (this.state.collapsed) {
      hasUnreadMessages = true;
    }
    this.setState({ messages, hasUnreadMessages });
  };

  _onSendMessage = data => {
    console.log('Send message:' + data);
    var info = {
      senderName: this.state.loginInfo.displayName,
      msg: data,
    };
    this.client.broadcast(info, this.client.rid);
    let messages = this.state.messages;
    let uid = 0;
    messages.push(new Message({ id: uid, message: data, senderName: 'me' }));
    this.setState({ messages });
  };

  isValidParams() {
    const validRoomPattern = /^[a-zA-Z0-9-.:_]*$/g;
    const validRoles = Object.values(ROLES);
    const validEnvs = Object.values(ENVS);
    try {
      const params = getRequest();

      if (params.role && !validRoles.includes(params.role.toLowerCase())) {
        return [false, 'Role'];
      } else if (params.env && !validEnvs.includes(params.env.toLowerCase())) {
        return [false, 'environment'];
      } else if (params.room && !validRoomPattern.test(params.room)) {
        return [false, 'Room ID'];
      } else {
        return [true, null];
      }
    } catch (error) {
      if (error instanceof URIError) {
        return [false, 'URL'];
      }
    }
  }

  render() {
    const {
      login,
      loading,
      localAudioEnabled,
      localVideoEnabled,
      screenSharingEnabled,
      collapsed,
      vidFit,
    } = this.state;

    const isValidParams = this.isValidParams()[0];

    return (
      <Layout className="app-layout">
        <Header
          className="app-header"
          style={{
            backgroundColor: '#1a1619',
            zIndex: '10',
            padding: '0 0',
            margin: '0 auto',
            width: '100%',
          }}
        >
          <div className="app-header-left">
            <a href="https://100ms.live/" target="_blank">
              <img src={bLogo} className="h-8" />
            </a>
          </div>
          <div className="app-header-right">
            <MediaSettings
              onMediaSettingsChanged={this._onMediaSettingsChanged}
              settings={this._settings}
              isLoggedIn={login}
            />
          </div>
        </Header>

        <Content className="app-center-layout">
          {!isValidParams ? (
            <div
              className="min-h-screen flex items-center justify-center w-full py-8 px-4 sm:px-6 lg:px-8"
              style={{ backgroundColor: '#1a1619' }}
            >
              <div className="overflow-hidden shadow rounded-lg max-w-sm w-full px-4 py-5 p-6 bg-gray-100">
                <div className="">
                  <h2 className="mt-2 text-center text-3xl leading-9 font-extrabold text-gray-900">
                    100ms Conference
                  </h2>

                  <p className="mt-2 text-center text-sm leading-5 text-gray-600 mb-2">
                    The requested {this.isValidParams()[1]} is invalid. Please
                    verify your credentials.
                  </p>
                </div>
              </div>
            </div>
          ) : login ? (
            <Layout className="app-content-layout">
              <Sider
                width={320}
                collapsedWidth={0}
                trigger={null}
                collapsible
                collapsed={this.state.collapsed}
                style={{ backgroundColor: '#1a1619' }}
              >
                <div className="left-container">
                  <ChatFeed
                    messages={this.state.messages}
                    onSendMessage={this._onSendMessage}
                    onClose={() => this._openOrCloseLeftContainer(!collapsed)}
                  />
                </div>
              </Sider>
              <Layout className="app-right-layout">
                <Content style={{ flex: 1, position: 'relative' }}>
                  <div>
                    <Conference
                      roomName={this.roomName}
                      roomId={this.roomId}
                      collapsed={this.state.collapsed}
                      client={this.client}
                      settings={this._settings}
                      localAudioEnabled={localAudioEnabled}
                      localVideoEnabled={localVideoEnabled}
                      vidFit={vidFit}
                      loginInfo={this.state.loginInfo}
                      ref={ref => {
                        this.conference = ref;
                      }}
                      isScreenSharing={screenSharingEnabled}
                      onScreenToggle={() =>
                        this._handleScreenSharing(!screenSharingEnabled)
                      }
                      onLeave={this._handleLeave}
                      onChatToggle={() => {
                        if (collapsed) {
                          this.setState({
                            hasUnreadMessages: false,
                          });
                        }
                        this._openOrCloseLeftContainer(!collapsed);
                      }}
                      isChatOpen={!this.state.collapsed}
                      cleanUp={this._cleanUp}
                      role={this.role}
                      hasUnreadMessages={this.state.hasUnreadMessages}
                    />
                  </div>
                </Content>
              </Layout>
            </Layout>
          ) : loading ? (
            <Spin size="large" tip="Connecting..." />
          ) : (
                  <div className="relative w-full mt-16">
                    <AppContext.Consumer>
                      {context => (
                        <LoginForm
                          appSettings={context.settings} loginInfo={context.loginInfo} setAppSettings={context.setSettings} setLoginInfo={context.setLoginInfo}
                          handleLogin={this._handleJoin}
                          createClient={this._createClient}
                        />
                         )}
                    </AppContext.Consumer>
               
            </div>
          )}
        </Content>
      </Layout>
    );
  }
}

class OldApp extends React.Component {
  render() {
    return (
      <AppContext.Consumer>
        {context => (
          <OldAppUI appSettings={context.settings} loginInfo={context.loginInfo} setAppSettings={context.setSettings} setLoginInfo={context.setLoginInfo} />
        )}
      </AppContext.Consumer>
    );
  }
};

class App extends React.Component {
  render() {
    return (
      <AppContextProvider>
        <OldApp />
      </AppContextProvider>
    );
  }
}

export default App;
