import React from 'react';
import Icon from './Icon.jsx';

export default function DocumentAvailability({ localAvailable, cloudAvailable }) {
  const locations = [
    localAvailable && 'on this device',
    cloudAvailable && 'in your account',
  ].filter(Boolean);
  if (!locations.length) return null;

  return <span className="document-availability" role="img" aria-label={`Available ${locations.join(' and ')}`}
    title={`Available ${locations.join(' and ')}`}>
    {localAvailable && <Icon name="device" className="availability-device" />}
    {cloudAvailable && <Icon name="cloud" className="availability-cloud" />}
  </span>;
}
