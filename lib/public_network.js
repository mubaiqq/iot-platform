const dns = require('dns');
const ipaddr = require('ipaddr.js');
const { Agent } = require('undici');

function isPublicAddress(address) {
  try {
    const parsed = ipaddr.process(String(address));
    return parsed.range() === 'unicast';
  } catch (_) {
    return false;
  }
}

function createPublicOnlyDispatcher() {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
            return callback(new Error('大模型地址不能解析到本机、私网或保留地址'));
          }
          if (options && options.all) return callback(null, addresses);
          const chosen = addresses[0];
          callback(null, chosen.address, chosen.family);
        });
      }
    }
  });
}

const publicOnlyDispatcher = createPublicOnlyDispatcher();

module.exports = { isPublicAddress, createPublicOnlyDispatcher, publicOnlyDispatcher };
