'use strict';

function passesLuhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function validateSAId(idNumber, today = new Date()) {
  const id = String(idNumber || '').replace(/\s+/g, '');
  if (!/^\d{13}$/.test(id)) return { valid: false, reason: 'ID number must be exactly 13 digits.' };

  const yy = Number(id.slice(0, 2));
  const month = Number(id.slice(2, 4));
  const day = Number(id.slice(4, 6));
  const currentYear = today.getUTCFullYear();
  let year = 2000 + yy;
  if (year > currentYear) year = 1900 + yy;

  const dob = new Date(Date.UTC(year, month - 1, day));
  if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== month - 1 || dob.getUTCDate() !== day || dob > today) {
    return { valid: false, reason: 'ID number contains an invalid date of birth.' };
  }
  if (![0, 1].includes(Number(id[10]))) {
    return { valid: false, reason: 'ID number contains an invalid citizenship digit.' };
  }
  if (!passesLuhn(id)) return { valid: false, reason: 'ID number failed the checksum.' };

  let age = currentYear - year;
  const beforeBirthday = today.getUTCMonth() + 1 < month || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  if (age < 18) return { valid: false, reason: 'You must be at least 18 years old to register.' };

  return {
    valid: true,
    dateOfBirth: dob,
    gender: Number(id.slice(6, 10)) >= 5000 ? 'male' : 'female',
    citizen: Number(id[10]) === 0
  };
}

module.exports = { validateSAId, passesLuhn };
