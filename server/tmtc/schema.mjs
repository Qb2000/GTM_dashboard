// ICD CDRL-1009 revision L (2024-09-26), Table 5-4, printed pages 23-28.
// Keep decoder values and engineering conversions as separate telemetry channels.
const uint = (bytes, start, length = 1) =>
  bytes.slice(start, start + length).reduce((value, byte) => value * 256 + byte, 0);
const signed = (value, bits) => (value >= 2 ** (bits - 1) ? value - 2 ** bits : value);

export function fieldsFor(module, inSpace = true) {
  const fields = [];
  function add(key, name, bytes, read, group = 'Packet', unit = 'raw', extra = {}) {
    fields.push({ key, name, bytes, read, group, unit, ...extra });
  }
  function at(start, length, name, group, unit) {
    add(
      `b${start}`,
      name,
      `${start}-${start + length - 1}`,
      (b) => uint(b, start, length),
      group,
      unit
    );
  }
  if (inSpace) {
    add('sequence', 'Source Sequence Count', 'Pre 2-3', (b, p) => uint(p, 2, 2) % 16384);
    ['Year', 'Day', 'Hour', 'Minute', 'Second', 'Subsecond'].forEach((name, i) => {
      const start = [6, 8, 10, 11, 12, 13][i];
      add(
        `gicd${name}`,
        `GICD ${name}`,
        `Pre ${start}`,
        (b, p) => uint(p, start, i < 2 ? 2 : 1),
        'Time'
      );
    });
  }
  at(0, 2, 'Header', 'Packet');
  add('b2', 'GTM ID', '2', (b) => (b[2] === 2 ? 0 : 1), 'Packet', 'code', {
    description: 'Decoder convention: Master=0, Slave=1; wire IDs are 0x02 and 0x05.'
  });
  at(3, 2, 'Packet Counter', 'Packet', 'count');
  at(5, 1, 'Data Length (MSB)', 'Packet');
  at(6, 1, 'Data Length', 'Packet', 'byte');
  ['Year', 'Day', 'Hour', 'Minute', 'Second', 'Subsecond'].forEach((name, i) => {
    const start = [7, 9, 11, 12, 13, 14][i];
    at(start, i < 2 ? 2 : 1, `ICD ${name}`, 'Time');
  });
  add('ppsId', 'GTM ID in Lastest PPS Counter', '15 bit 7', (b) => Math.floor(b[15] / 128), 'Time');
  add('b15', 'Lastest PPS Counter', '15-16', (b) => uint(b, 15, 2) % 32768, 'Time', 'count');
  at(17, 3, 'Lastest Fine Time Counter Value Between 2 PPSs', 'Time', 'count');
  [20, 21].forEach((start, i) => {
    add(
      `b${start}`,
      `Board Temperature#${i + 1}`,
      `${start}`,
      (b) => signed(b[start], 8),
      'Temperature',
      'raw'
    );
  });
  [22, 23].forEach((start, i) => {
    add(
      `b${start}`,
      `CITIROC${i + 1} Temperature`,
      `${start},${start + 2}`,
      (b) => signed(Math.floor(b[start + 2] / 2) * 256 + b[start], 15),
      'Temperature',
      'raw',
      {
        description:
          'Signed 15-bit decoder value. No temperature calibration is specified in Table 5-4.'
      }
    );
  });
  [26, 29].forEach((start, i) =>
    at(start, 3, `CITIROC${i + 1} Live Time (Busy)`, 'Live Time', 'tick')
  );
  [1, 2].forEach((asic) => {
    for (let channel = 0; channel < 32; channel++) {
      at(
        32 * asic + channel,
        1,
        `CITIROC${asic} Hit Counter#${channel}`,
        `CITIROC${asic} Hits`,
        'count'
      );
    }
  });
  [96, 98].forEach((start, i) =>
    at(start, 2, `CITIROC${i + 1} Trigger Counter`, 'Counters', 'count')
  );
  at(100, 1, 'Counter Period Setting', 'Counters', 'code');
  at(101, 1, 'HV DAC1', 'HV / Power', 'code');
  at(102, 1, 'HV DAC2', 'HV / Power', 'code');
  if (module === 'master') {
    at(103, 1, 'SPW#A Error Count', 'SpaceWire');
    at(104, 1, 'SPW#A Last Recv Byte', 'SpaceWire');
    at(105, 1, 'SPW#B Error Count', 'SpaceWire');
    at(106, 1, 'SPW#B Last Recv Byte', 'SpaceWire');
    at(107, 2, 'SPW#A Status', 'SpaceWire');
    at(109, 2, 'SPW#B Status', 'SpaceWire');
  } else {
    add(
      'b103',
      'Input Current Value',
      '103,105 high nibble',
      (b) => b[103] * 16 + Math.floor(b[105] / 16),
      'HV / Power'
    );
    add(
      'b104',
      'Input Voltage Value',
      '104,105 low nibble',
      (b) => b[104] * 16 + (b[105] % 16),
      'HV / Power'
    );
    add(
      'b106',
      'Current Monitor Chip (U22) Temperature',
      '106',
      (b) => signed(b[106], 8),
      'Temperature'
    );
    // Rev L explicitly reverses the current/voltage low nibbles for HV byte 109.
    add(
      'b107',
      'HV Input Current Value',
      '107,109 low nibble',
      (b) => b[107] * 16 + (b[109] % 16),
      'HV / Power'
    );
    add(
      'b108',
      'HV Input Voltage Value',
      '108,109 high nibble',
      (b) => b[108] * 16 + Math.floor(b[109] / 16),
      'HV / Power'
    );
    add(
      'b110',
      'Current Monitor Chip (U21) Temperature',
      '110',
      (b) => signed(b[110], 8),
      'Temperature'
    );
  }
  at(111, 1, 'Recv Checksum of Last CMD', 'Commands');
  at(112, 1, 'Calc Checksum of Last CMD', 'Commands');
  at(113, 1, 'Number of Recv CMDs', 'Commands', 'count');
  [114, 115, 116, 117, 118].forEach((start, i) => {
    const memory = ['uRAM', 'uRAM', 'LRAM', 'LRAM', 'logic cells'][i];
    const bits = i === 4 ? '' : i % 2 === 0 ? ' (bit8-0)' : ' (bit17-9)';
    add(
      `b${start}`,
      `SEE counts of ${memory}${bits}`,
      `${start}`,
      (b) => b[start],
      'SEE',
      'count',
      {
        csvName: `SEE counts of ${memory}`,
        occurrence: i === 4 ? 0 : i % 2
      }
    );
  });
  [119, 122].forEach((start, i) =>
    at(start, 3, `CITIROC${i + 1} Live Time (Buffer+Busy)`, 'Live Time', 'tick')
  );
  at(125, 1, 'Checksum', 'Packet');
  at(126, 2, 'Tail', 'Packet');

  const derive = (key, name, from, scale, unit, description) => {
    add(key, name, '', null, 'Engineering', unit, {
      derive: (values) => (values[from] === null ? null : values[from] * scale),
      description
    });
  };
  [26, 29, 119, 122].forEach((start) => {
    const field = fields.find((f) => f.key === `b${start}`);
    derive(
      `seconds${start}`,
      `${field.name} [seconds]`,
      field.key,
      80e-9,
      's',
      'ICD Table 5-4: 80 ns per tick.'
    );
    derive(
      `percent${start}`,
      `${field.name} [%]`,
      field.key,
      100 / 0xbebc1f,
      '%',
      'ICD Table 5-4: 100% = 0xBEBC1F.'
    );
  });
  if (module === 'slave') {
    [103, 107].forEach((start) =>
      derive(
        `amps${start}`,
        start === 103 ? 'Input Current [A]' : 'HV Input Current [A]',
        `b${start}`,
        5.324e-4,
        'A',
        'ICD Table 5-4: 5.324e-4 A per count.'
      )
    );
    [104, 108].forEach((start) =>
      derive(
        `volts${start}`,
        start === 104 ? 'Input Voltage [V]' : 'HV Input Voltage [V]',
        `b${start}`,
        0.01442,
        'V',
        'ICD Table 5-4: calibrated 0.01442 V per count.'
      )
    );
    // Preserve the decoder's signed-int8 convention; document it explicitly.
    [106, 110].forEach((start) =>
      derive(
        `celsius${start}`,
        `Current Monitor U${start === 106 ? '22' : '21'} [degC]`,
        `b${start}`,
        0.48,
        'degC',
        'ICD: 0.48 degC/LSB; signed int8 interpretation follows the existing decoder.'
      )
    );
  }
  if (module === 'master') {
    [103, 105].forEach((start, i) => {
      add(
        `errors${start}`,
        `SPW#${i === 0 ? 'A' : 'B'} Error Count [bits7-1]`,
        `${start}`,
        null,
        'Engineering',
        'count',
        { derive: (v) => (v[`b${start}`] === null ? null : Math.floor(v[`b${start}`] / 2)) }
      );
      add(
        `cd${start}`,
        `SPW#${i === 0 ? 'A' : 'B'} Last Byte C/D bit`,
        `${start}`,
        null,
        'Engineering',
        'bit',
        { derive: (v) => (v[`b${start}`] === null ? null : v[`b${start}`] % 2) }
      );
    });
  }
  add('periodMs', 'Counter Period [ms]', '100', null, 'Engineering', 'ms', {
    derive: (v) =>
      v.b100 === null ? null : { 1: 1, 2: 5, 4: 20, 241: 250, 242: 1000 }[v.b100] ?? 100
  });
  return fields;
}

export function packetUTC(values, subsecondMilliseconds = null) {
  const [year, day, hour, minute, second] = ['b7', 'b9', 'b11', 'b12', 'b13'].map(
    (key) => values[key]
  );
  if (![year, day, hour, minute, second].every(Number.isInteger) || year < 1970 || year > 9999) {
    return null;
  }
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  if (
    day < 1 ||
    day > days ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  let fraction = 0;
  if (subsecondMilliseconds !== null) {
    fraction = values.b14 * subsecondMilliseconds;
    if (values.b14 === null || !Number.isFinite(fraction) || fraction < 0 || fraction >= 1000) {
      return null;
    }
  }
  return Date.UTC(year, 0, day, hour, minute, second) + fraction;
}
