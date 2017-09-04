import mumbleStreams from 'mumble-streams'
import duplexer from 'reduplexer'
import { EventEmitter } from 'events'
import through2 from 'through2'
import Promise from 'promise'
import DropStream from 'drop-stream'
import { getOSName, getOSVersion } from './utils.js'
import User from './user'
import Channel from './channel'
import removeValue from 'remove-value'

const DenyType = mumbleStreams.data.messages.PermissionDenied.DenyType

/*
 * @typedef {'Opus'} Codec
 */

/**
 * Number of the voice target when outgoing (0 for normal talking, 1-31 for
 * a voice target).
 * String describing the source when incoming.
 * @typedef {number|'normal'|'shout'|'whisper'} VoiceTarget
 */

/**
 * @typedef {object} VoiceData
 * @property {VoiceTarget} target - Target of the audio
 * @property {Codec} codec - The codec of the audio packet
 * @property {Buffer} frame - Encoded audio frame, null indicates a lost frame
 * @property {?Position} position - Position of audio source
 */

/**
 * Interleaved 32-bit float PCM frames in [-1; 1] range with sample rate of 48k.
 * @typedef {object} PCMData
 * @property {VoiceTarget} target - Target of the audio
 * @property {Float32Array} pcm - The pcm data
 * @property {number} numberOfChannels - Number of channels
 * @property {?Position} position - Position of audio source
 */

/**
 * Transforms {@link VoiceData} to {@link PCMData}.
 * Should ignore any unknown codecs.
 *
 * @interface DecoderStream
 * @extends stream.Transform
 */

/**
 * Transforms {@link PCMData} to {@link VoiceData}.
 *
 * @interface EncoderStream
 * @extends stream.Transform
 */

/**
 * @interface Codecs
 * @property {number[]} celt - List of celt versions supported by this implementation
 * @property {boolean} opus - Whether this implementation supports the Opus codec
 */

/**
 * Returns the duration of encoded voice data without actually decoding it.
 *
 * @function Codecs#getDuration
 * @param {Codec} codec - The codec
 * @param {Buffer} buffer - The encoded data
 * @return {number} The duration in milliseconds (has to be a multiple of 10)
 */

/**
 * Creates a new decoder stream for a transmission of the specified user.
 * This method is called for every single transmission (whenever a user starts
 * speaking), as such it must not be expensive.
 *
 * @function Codecs#createDecoderStream
 * @param {User} user - The user
 * @return {DecoderStream} The decoder stream
 */

/**
 * Creates a new encoder stream for a outgoing transmission.
 * This method is called for every single transmission (whenever the user
 * starts speaking), as such it must not be expensive.
 *
 * @function Codecs#createEncoderStream
 * @param {Codec} codec - The codec
 * @return {EncoderStream} The endecoder stream
 */

/**
 * Single use Mumble client.
 */
class MumbleClient extends EventEmitter {
  /**
   * A mumble client.
   * This object may only be connected to one server and cannot be reused.
   *
   * @param {object} options - Options
   * @param {string} options.username - User name of the client
   * @param {string} [options.password] - Server password to use
   * @param {string[]} [options.tokens] - Array of access tokens to use
   * @param {string} [options.clientSoftware] - Client software name/version
   * @param {string} [options.osName] - Client operating system name
   * @param {string} [options.osVersion] - Client operating system version
   * @param {Codecs} [options.codecs] - Codecs used for voice
   * @param {number} [options.userVoiceTimeout] - Milliseconds after which an
   *  inactive voice transmissions is timed out
   */
  constructor (options) {
    super()

    if (!options.username) {
      throw new Error('No username given')
    }

    this._options = options || {}
    this._username = options.username
    this._password = options.password
    this._tokens = options.tokens
    this._codecs = options.codecs

    this._userById = {}
    this._channelById = {}

    this.users = []
    this.channels = []

    this._dataEncoder = new mumbleStreams.data.Encoder()
    this._dataDecoder = new mumbleStreams.data.Decoder()
    this._voiceEncoder = new mumbleStreams.voice.Encoder('server')
    this._voiceDecoder = new mumbleStreams.voice.Decoder('server')
    this._data = duplexer(this._dataEncoder, this._dataDecoder, {objectMode: true})
    this._voice = duplexer(this._voiceEncoder, this._voiceDecoder, {objectMode: true})

    this._data.on('data', this._onData.bind(this))
    this._voice.on('data', this._onVoice.bind(this))
    this._voiceEncoder.on('data', data => {
      // TODO This should only be the fallback option
      this._data.write({
        name: 'UDPTunnel',
        payload: data
      })
    })
  }

  _send (msg) {
    this._data.write(msg)
  }

  /**
   * Connects this client to a duplex stream that is used for the data channel.
   * The provided duplex stream is expected to be valid and usable.
   * Calling this method will begin the initialization of the connection.
   *
   * @param stream - The stream used for the data channel.
   * @param callback - Optional callback that is invoked when the connection has been established.
   */
  connectDataStream (stream, callback) {
    if (this._dataStream) throw Error('Already connected!')
    this._dataStream = stream

    // Connect the supplied stream to the data channel encoder and decoder
    this._dataEncoder.pipe(stream).pipe(this._dataDecoder)

    // Send the initial two packets
    this._send({
      name: 'Version',
      payload: {
        version: mumbleStreams.version.toUInt8(),
        release: this._options.clientSoftware || 'Node.js mumble-client',
        os: this._options.osName || getOSName(),
        os_version: this._options.osVersion || getOSVersion()
      }
    })
    this._send({
      name: 'Authenticate',
      payload: {
        username: this._username,
        password: this._password,
        tokens: this._tokens,
        celt_versions: (this._codecs || { celt: [] }).celt,
        opus: (this._codecs || { opus: false }).opus
      }
    })

    return new Promise((resolve, reject) => {
      this.once('connected', () => resolve(this))
      this.once('reject', reject)
      this.once('error', reject)
    }).nodeify(callback)
  }

  /**
   * Connects this client to a duplex stream that is used for the voice channel.
   * The provided duplex stream is expected to be valid and usable.
   * The stream may be unreliable. That is, it may lose packets or deliver them
   * out of order.
   * It must however gurantee that packets arrive unmodified and/or are dropped
   * when corrupted.
   * It is also responsible for any encryption that is necessary.
   *
   * Connecting a voice channel is entirely optional. If no voice channel
   * is connected, all voice data is tunneled through the data channel.
   *
   * @param stream - The stream used for the data channel.
   * @returns {undefined}
   */
  connectVoiceStream (stream) {
    // Connect the stream to the voice channel encoder and decoder
    this._voiceEncoder.pipe(stream).pipe(this._voiceDecoder)

    // TODO: Ping packet
  }

  createVoiceStream (target = 0, numberOfChannels = 1) {
    if (!this._codecs) {
      return DropStream.obj()
    }
    var voiceStream = through2.obj((chunk, encoding, callback) => {
      if (chunk instanceof Buffer) {
        chunk = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4)
      }
      if (chunk instanceof Float32Array) {
        chunk = {
          target: target,
          pcm: chunk,
          numberOfChannels: numberOfChannels
        }
      } else {
        chunk = {
          target: target,
          pcm: chunk.pcm,
          numberOfChannels: numberOfChannels,
          position: { x: chunk.x, y: chunk.y, z: chunk.z }
        }
      }
      callback(null, chunk)
    })
    const codec = 'Opus' // TODO
    var seqNum = 0
    voiceStream
      .pipe(this._codecs.createEncoderStream(codec))
      .on('data', data => {
        this._voice.write({
          seqNum: seqNum++,
          codec: codec,
          target: target,
          frames: [data.frame],
          position: data.position,
          end: false
        })
      }).on('end', () => {
        this._voice.write({
          seqNum: seqNum,
          codec: codec,
          target: target,
          frames: [],
          end: true
        })
      })
    return voiceStream
  }

  /**
   * Method called when new voice packets arrive.
   * Forwards the packet to the source user.
   */
  _onVoice (chunk) {
    var user = this._userById[chunk.source]
    user._onVoice(chunk.seqNum, chunk.codec, chunk.target, chunk.frames,
      chunk.position, chunk.end)
  }

  /**
   * Method called when new data packets arrive.
   * If there is a method named '_onPacketName', the data is forwarded to
   * that method, otherwise it is logged as unhandled.
   *
   * @param {object} chunk - The data packet
   */
  _onData (chunk) {
    if (this['_on' + chunk.name]) {
      this['_on' + chunk.name](chunk.payload)
    } else {
      console.log('Unhandled data packet:', chunk)
    }
  }

  _onUDPTunnel (payload) {
    // Forward tunneled udp packets to the voice pipeline
    this._voiceDecoder.write(payload)
  }

  _onServerSync (payload) {
    // This packet finishes the initialization phase
    this.self = this._userById[payload.session]
    this.maxBandwidth = payload.max_bandwidth
    this.welcomeMessage = payload.welcome_text

    // Make sure we send regular ping packets to not get disconnected
    this._pinger = setInterval(() => {
      this._send({
        name: 'Ping',
        payload: {
          timestamp: new Date().getTime()
        }
      })
    }, 10000)

    // We are now connected
    this.emit('connected')
  }

  _onReject (payload) {
    // We got rejected from the server for some reason.
    this.emit('reject', payload)
    this.disconnect()
  }

  _onPermissionDenied (payload) {
    if (payload.type === DenyType.Text) {
      this.emit('denied', 'Text', null, null, payload.reason)
    } else if (payload.type === DenyType.Permission) {
      let user = this._userById[payload.session]
      let channel = this._channelById[payload.channel_id]
      this.emit('denied', 'Permission', user, channel, payload.permission)
    } else if (payload.type === DenyType.SuperUser) {
      this.emit('denied', 'SuperUser', null, null, null)
    } else if (payload.type === DenyType.ChannelName) {
      this.emit('denied', 'ChannelName', null, null, payload.name)
    } else if (payload.type === DenyType.TextTooLong) {
      this.emit('denied', 'TextTooLong', null, null, null)
    } else if (payload.type === DenyType.TemporaryChannel) {
      this.emit('denied', 'TemporaryChannel', null, null, null)
    } else if (payload.type === DenyType.MissingCertificate) {
      let user = this._userById[payload.session]
      this.emit('denied', 'MissingCertificate', user, null, null)
    } else if (payload.type === DenyType.UserName) {
      this.emit('denied', 'UserName', null, null, payload.name)
    } else if (payload.type === DenyType.ChannelFull) {
      this.emit('denied', 'ChannelFull', null, null, null)
    } else if (payload.type === DenyType.NestingLimit) {
      this.emit('denied', 'NestingLimit', null, null, null)
    } else {
      throw Error('Invalid DenyType: ' + payload.type)
    }
  }

  _onTextMessage (payload) {
    this.emit('message',
      this._userById[payload.actor],
      payload.message,
      payload.session.map(id => this._userById[id]),
      payload.channel_id.map(id => this._channelById[id]),
      payload.tree_id.map(id => this._channelById[id])
    )
  }

  _onChannelState (payload) {
    var channel = this._channelById[payload.channel_id]
    if (!channel) {
      channel = new Channel(this, payload.channel_id)
      this._channelById[channel._id] = channel
      this.channels.push(channel)
      this.emit('newChannel', channel)
    }
    (payload.links_remove || []).forEach(otherId => {
      var otherChannel = this._channelById[otherId]
      if (otherChannel && otherChannel.links.indexOf(channel) !== -1) {
        otherChannel._update({
          links_remove: [payload.channel_id]
        })
      }
    })
    channel._update(payload)
  }

  _onChannelRemove (payload) {
    var channel = this._channelById[payload.channel_id]
    if (channel) {
      channel._remove()
      delete this._channelById[channel._id]
      removeValue(this.channels, channel)
    }
  }

  _onUserState (payload) {
    var user = this._userById[payload.session]
    if (!user) {
      user = new User(this, payload.session)
      this._userById[user._id] = user
      this.users.push(user)
      this.emit('newUser', user)

      // For some reason, the mumble protocol does not send the initial
      // channel of a client if it is the root channel
      payload.channel_id = payload.channel_id || 0
    }
    user._update(payload)
  }

  _onUserRemove (payload) {
    var user = this._userById[payload.session]
    if (user) {
      user._remove(this._userById[payload.actor], payload.reason, payload.ban)
      delete this._userById[user._id]
      removeValue(this.users, user)
    }
  }

  /**
   * Disconnect from the remote server.
   * Once disconnected, this client may not be used again.
   * Does nothing when not connected.
   */
  disconnect () {
    this.voice.end()
    this.data.end()
  }

  /**
   * Find a channel by name.
   * If no such channel exists, return null.
   *
   * @param {string} name - The full name of the channel
   * @returns {?Channel}
   */
  getChannel (name) {
    for (let channel of this.channels) {
      if (channel.name === name) {
        return channel
      }
    }
    return null
  }

  setSelfMute (mute) {
    var message = {
      name: 'UserState',
      payload: {
        session: this.self._id,
        self_mute: mute
      }
    }
    if (!mute) message.payload.self_deaf = false
    this._send(message)
  }

  setSelfDeaf (deaf) {
    var message = {
      name: 'UserState',
      payload: {
        session: this.self._id,
        self_deaf: deaf
      }
    }
    if (deaf) message.payload.self_mute = true
    this._send(message)
  }

  setSelfTexture (texture) {
    this._send({
      name: 'UserState',
      payload: {
        session: this.self._id,
        texture: texture
      }
    })
  }

  setSelfComment (comment) {
    this._send({
      name: 'UserState',
      payload: {
        session: this.self._id,
        comment: comment
      }
    })
  }

  setPluginContext (context) {
    this._send({
      name: 'UserState',
      payload: {
        session: this.self._id,
        plugin_context: context
      }
    })
  }

  setPluginIdentity (identity) {
    this._send({
      name: 'UserState',
      payload: {
        session: this.self._id,
        plugin_identity: identity
      }
    })
  }

  setRecording (recording) {
    this._send({
      name: 'UserState',
      payload: {
        session: this.self._id,
        recording: recording
      }
    })
  }

  get root () {
    return this._channelById[0]
  }
}

export default MumbleClient