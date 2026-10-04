/**
 * Location-based banners:
 * - `locations` collection seeded with India → states/UTs → main cities
 *   (aliases cover common alternative spellings).
 * - `banners` collection with its indexes.
 * Idempotent: existing locations (same parent + name) are kept as they are.
 *
 * Down: drops `banners` and `locations`. Uploaded image files are left on disk.
 */
import { Banner } from '../src/modules/banners/banner.model.js';
import { Location } from '../src/modules/locations/location.model.js';

// [state, ISO 3166-2 code, aliases, cities: [name, aliases?]]
const INDIA = [
  ['Andhra Pradesh', 'IN-AP', ['AP'], [['Visakhapatnam', ['Vizag', 'Vishakhapatnam']], ['Vijayawada', ['Bezawada']], ['Guntur'], ['Nellore'], ['Tirupati'], ['Kurnool'], ['Rajahmundry', ['Rajamahendravaram']], ['Kakinada']]],
  ['Arunachal Pradesh', 'IN-AR', [], [['Itanagar']]],
  ['Assam', 'IN-AS', [], [['Guwahati', ['Gauhati']], ['Dibrugarh'], ['Silchar']]],
  ['Bihar', 'IN-BR', [], [['Patna'], ['Gaya'], ['Bhagalpur'], ['Muzaffarpur']]],
  ['Chhattisgarh', 'IN-CT', ['Chattisgarh'], [['Raipur'], ['Bhilai'], ['Bilaspur']]],
  ['Goa', 'IN-GA', [], [['Panaji', ['Panjim']], ['Margao', ['Madgaon']]]],
  ['Gujarat', 'IN-GJ', [], [['Ahmedabad', ['Amdavad']], ['Surat'], ['Vadodara', ['Baroda']], ['Rajkot'], ['Gandhinagar']]],
  ['Haryana', 'IN-HR', [], [['Gurugram', ['Gurgaon']], ['Faridabad'], ['Panipat'], ['Ambala']]],
  ['Himachal Pradesh', 'IN-HP', ['HP'], [['Shimla', ['Simla']], ['Dharamshala']]],
  ['Jharkhand', 'IN-JH', [], [['Ranchi'], ['Jamshedpur'], ['Dhanbad']]],
  ['Karnataka', 'IN-KA', [], [['Bengaluru', ['Bangalore', 'Bengaluru Urban', 'Bangalore Urban']], ['Mysuru', ['Mysore']], ['Mangaluru', ['Mangalore']], ['Hubballi', ['Hubli', 'Hubli-Dharwad']], ['Belagavi', ['Belgaum']], ['Kalaburagi', ['Gulbarga']], ['Davanagere']]],
  ['Kerala', 'IN-KL', [], [['Thiruvananthapuram', ['Trivandrum']], ['Kochi', ['Cochin', 'Ernakulam']], ['Kozhikode', ['Calicut']], ['Thrissur', ['Trichur']]]],
  ['Madhya Pradesh', 'IN-MP', ['MP'], [['Indore'], ['Bhopal'], ['Jabalpur'], ['Gwalior']]],
  ['Maharashtra', 'IN-MH', [], [['Mumbai', ['Bombay']], ['Pune', ['Poona']], ['Nagpur'], ['Nashik', ['Nasik']], ['Thane'], ['Aurangabad', ['Chhatrapati Sambhajinagar']], ['Navi Mumbai']]],
  ['Manipur', 'IN-MN', [], [['Imphal']]],
  ['Meghalaya', 'IN-ML', [], [['Shillong']]],
  ['Mizoram', 'IN-MZ', [], [['Aizawl']]],
  ['Nagaland', 'IN-NL', [], [['Kohima'], ['Dimapur']]],
  ['Odisha', 'IN-OR', ['Orissa'], [['Bhubaneswar'], ['Cuttack'], ['Rourkela']]],
  ['Punjab', 'IN-PB', [], [['Ludhiana'], ['Amritsar'], ['Jalandhar'], ['Mohali', ['SAS Nagar']]]],
  ['Rajasthan', 'IN-RJ', [], [['Jaipur'], ['Jodhpur'], ['Udaipur'], ['Kota'], ['Ajmer']]],
  ['Sikkim', 'IN-SK', [], [['Gangtok']]],
  ['Tamil Nadu', 'IN-TN', ['TN'], [['Chennai', ['Madras']], ['Coimbatore'], ['Madurai'], ['Tiruchirappalli', ['Trichy']], ['Salem'], ['Vellore']]],
  ['Telangana', 'IN-TG', ['Telengana', 'TS'], [['Hyderabad', ['Secunderabad', 'Hyderabad Deccan']], ['Warangal'], ['Karimnagar'], ['Nizamabad'], ['Khammam']]],
  ['Tripura', 'IN-TR', [], [['Agartala']]],
  ['Uttar Pradesh', 'IN-UP', ['UP'], [['Lucknow'], ['Kanpur'], ['Noida', ['Gautam Buddh Nagar']], ['Ghaziabad'], ['Agra'], ['Varanasi', ['Banaras', 'Benares']], ['Prayagraj', ['Allahabad']]]],
  ['Uttarakhand', 'IN-UT', ['Uttaranchal'], [['Dehradun'], ['Haridwar']]],
  ['West Bengal', 'IN-WB', ['WB'], [['Kolkata', ['Calcutta']], ['Howrah'], ['Siliguri'], ['Durgapur']]],
  ['Andaman and Nicobar Islands', 'IN-AN', [], [['Port Blair', ['Sri Vijaya Puram']]]],
  ['Chandigarh', 'IN-CH', [], [['Chandigarh']]],
  ['Dadra and Nagar Haveli and Daman and Diu', 'IN-DH', [], [['Daman'], ['Silvassa']]],
  ['Delhi', 'IN-DL', ['NCT of Delhi', 'New Delhi'], [['New Delhi'], ['Delhi']]],
  ['Jammu and Kashmir', 'IN-JK', ['J&K'], [['Srinagar'], ['Jammu']]],
  ['Ladakh', 'IN-LA', [], [['Leh']]],
  ['Lakshadweep', 'IN-LD', [], [['Kavaratti']]],
  ['Puducherry', 'IN-PY', ['Pondicherry'], [['Puducherry', ['Pondicherry']]]],
];

async function ensure(doc) {
  const existing = await Location.findOne({ parent: doc.parent, name: doc.name }).collation({ locale: 'en', strength: 2 });
  return existing ?? Location.create(doc);
}

export async function up({ log }) {
  await Location.syncIndexes();
  await Banner.syncIndexes();
  const india = await ensure({ name: 'India', code: 'IN', type: 'country', parent: null });
  let cities = 0;
  for (const [name, code, aliases, cityList] of INDIA) {
    const state = await ensure({ name, code, type: 'state', parent: india._id, aliases });
    for (const [city, cityAliases = []] of cityList) {
      await ensure({ name: city, type: 'city', parent: state._id, aliases: cityAliases });
      cities += 1;
    }
  }
  log(`  locations: India, ${INDIA.length} states/UTs, ${cities} cities`);
}

export async function down({ db, log }) {
  for (const name of ['banners', 'locations']) {
    if (await db.listCollections({ name }).hasNext()) await db.dropCollection(name);
  }
  log('  dropped banners and locations');
}
