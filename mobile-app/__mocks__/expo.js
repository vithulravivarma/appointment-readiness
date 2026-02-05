
const React = require('react');

module.exports = {
    registerRootComponent: jest.fn(),
    keepAwake: jest.fn(),
    manifest: {},
    // Add other common exports used by libs
    EventEmitter: class EventEmitter {
        addListener() { return { remove: jest.fn() }; }
        removeListener() { }
        emit() { }
    },
};
