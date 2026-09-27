/**
 * Location normalization, aliasing and metro-area matching.
 *
 * A hackathon belongs to a city by *where it happens*, not by where its organizer
 * is registered. This module only resolves place names; it never decides that an
 * event "happens in" a city by itself.
 *
 * Coordinates are deliberately absent from this file. Coordinates come from a
 * real geocoder at ingest/search time and are persisted with their provenance, so
 * no coordinate in this codebase is hand-written or guessed.
 */

export interface CityDefinition {
  /** Canonical display name. */
  name: string;
  /** Stable key derived from the canonical name. */
  slug: string;
  country: string;
  countryCode: string;
  state?: string | null;
  /** Alternate / historical / anglicised spellings, all real-world names. */
  aliases?: string[];
  /** Metro grouping key. Members of a metro group are "nearby" each other. */
  metro?: string | null;
  /**
   * True when this entry is a locality, suburb, campus area or district inside
   * its metro rather than the city people search for by name.
   */
  locality?: boolean;
}

export const METRO_DEFS: Array<{ key: string; label: string; primary: string }> = [
  { key: 'mumbai', label: 'Mumbai Metropolitan Region', primary: 'Mumbai' },
  { key: 'delhi-ncr', label: 'Delhi NCR', primary: 'Delhi' },
  { key: 'bengaluru', label: 'Bengaluru Urban Region', primary: 'Bengaluru' },
  { key: 'chennai', label: 'Chennai Metropolitan Area', primary: 'Chennai' },
  { key: 'hyderabad', label: 'Hyderabad Metropolitan Region', primary: 'Hyderabad' },
  { key: 'pune', label: 'Pune Metropolitan Region', primary: 'Pune' },
  { key: 'kolkata', label: 'Kolkata Metropolitan Area', primary: 'Kolkata' },
  { key: 'ahmedabad', label: 'Ahmedabad Metropolitan Area', primary: 'Ahmedabad' },
  { key: 'kochi', label: 'Kochi Metropolitan Area', primary: 'Kochi' },
  { key: 'jaipur', label: 'Jaipur Metropolitan Region', primary: 'Jaipur' },
  { key: 'lucknow', label: 'Lucknow Metropolitan Area', primary: 'Lucknow' },
  { key: 'nagpur', label: 'Nagpur Metropolitan Area', primary: 'Nagpur' },
  { key: 'new-york', label: 'New York Metropolitan Area', primary: 'New York' },
  { key: 'bay-area', label: 'San Francisco Bay Area', primary: 'San Francisco' },
  { key: 'los-angeles', label: 'Greater Los Angeles', primary: 'Los Angeles' },
  { key: 'london', label: 'Greater London', primary: 'London' },
  { key: 'toronto', label: 'Greater Toronto Area', primary: 'Toronto' },
  { key: 'berlin', label: 'Berlin-Brandenburg', primary: 'Berlin' },
  { key: 'amsterdam', label: 'Randstad', primary: 'Amsterdam' },
];

const IND = { country: 'India', countryCode: 'IN' } as const;

/**
 * Cities and localities we can normalize confidently.
 * Locality entries carry `locality: true` so they surface as "nearby" rather
 * than as the city itself.
 */
export const CITY_DEFINITIONS: CityDefinition[] = [
  // ---- Mumbai metro -------------------------------------------------------
  { name: 'Mumbai', slug: 'mumbai', ...IND, state: 'Maharashtra', aliases: ['Bombay', 'Bombay City', 'Mumbai City'], metro: 'mumbai' },
  { name: 'Navi Mumbai', slug: 'navi-mumbai', ...IND, state: 'Maharashtra', aliases: ['New Mumbai', 'Navi Bombay'], metro: 'mumbai', locality: true },
  { name: 'Thane', slug: 'thane', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Vasai-Virar', slug: 'vasai-virar', ...IND, state: 'Maharashtra', aliases: ['Vasai', 'Virar'], metro: 'mumbai', locality: true },
  { name: 'Kalyan', slug: 'kalyan', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Bhiwandi', slug: 'bhiwandi', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Panvel', slug: 'panvel', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Vashi', slug: 'vashi', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Karjat', slug: 'karjat', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Powai', slug: 'powai', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Dadar', slug: 'dadar', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Andheri', slug: 'andheri', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Bandra', slug: 'bandra', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Borivali', slug: 'borivali', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Wadala', slug: 'wadala', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Sion', slug: 'sion', ...IND, state: 'Maharashtra', aliases: ['Sion Mumbai'], metro: 'mumbai', locality: true },
  { name: 'Kurla', slug: 'kurla', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },
  { name: 'Malad', slug: 'malad', ...IND, state: 'Maharashtra', metro: 'mumbai', locality: true },

  // ---- Delhi NCR ----------------------------------------------------------
  { name: 'Delhi', slug: 'delhi', ...IND, state: 'Delhi', aliases: ['New Delhi', 'Delhi NCR', 'National Capital Territory of Delhi', 'NCT of Delhi'], metro: 'delhi-ncr' },
  { name: 'Noida', slug: 'noida', ...IND, state: 'Uttar Pradesh', aliases: ['Noida Uttar Pradesh'], metro: 'delhi-ncr', locality: true },
  { name: 'Greater Noida', slug: 'greater-noida', ...IND, state: 'Uttar Pradesh', aliases: ['Gr. Noida'], metro: 'delhi-ncr', locality: true },
  { name: 'Ghaziabad', slug: 'ghaziabad', ...IND, state: 'Uttar Pradesh', metro: 'delhi-ncr', locality: true },
  { name: 'Gurugram', slug: 'gurugram', ...IND, state: 'Haryana', aliases: ['Gurgaon'], metro: 'delhi-ncr', locality: true },
  { name: 'Faridabad', slug: 'faridabad', ...IND, state: 'Haryana', metro: 'delhi-ncr', locality: true },
  { name: 'Dwarka', slug: 'dwarka', ...IND, state: 'Delhi', metro: 'delhi-ncr', locality: true },
  { name: 'Rohini', slug: 'rohini', ...IND, state: 'Delhi', metro: 'delhi-ncr', locality: true },
  { name: 'West Delhi', slug: 'west-delhi', ...IND, state: 'Delhi', aliases: ['Pitampura', 'Dwarka West'], metro: 'delhi-ncr', locality: true },
  { name: 'South Delhi', slug: 'south-delhi', ...IND, state: 'Delhi', metro: 'delhi-ncr', locality: true },
  { name: 'North Delhi', slug: 'north-delhi', ...IND, state: 'Delhi', metro: 'delhi-ncr', locality: true },
  { name: 'East Delhi', slug: 'east-delhi', ...IND, state: 'Delhi', metro: 'delhi-ncr', locality: true },
  { name: 'Dasna', slug: 'dasna', ...IND, state: 'Uttar Pradesh', metro: 'delhi-ncr', locality: true },
  { name: 'Muradnagar', slug: 'muradnagar', ...IND, state: 'Uttar Pradesh', metro: 'delhi-ncr', locality: true },
  { name: 'Gautam Buddha Nagar', slug: 'gautam-buddha-nagar', ...IND, state: 'Uttar Pradesh', metro: 'delhi-ncr', locality: true },
  { name: 'Dadri', slug: 'dadri', ...IND, state: 'Uttar Pradesh', metro: 'delhi-ncr', locality: true },

  // ---- Bengaluru ----------------------------------------------------------
  { name: 'Bengaluru', slug: 'bengaluru', ...IND, state: 'Karnataka', aliases: ['Bangalore', 'Bangalore Urban', 'Bengaluru Urban', 'Bangalore Urban District'], metro: 'bengaluru' },
  { name: 'Whitefield', slug: 'whitefield', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Koramangala', slug: 'koramangala', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Electronic City', slug: 'electronic-city', ...IND, state: 'Karnataka', aliases: ['Electronics City'], metro: 'bengaluru', locality: true },
  { name: 'Yelahanka', slug: 'yelahanka', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Jayanagar', slug: 'jayanagar', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Marathahalli', slug: 'marathahalli', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'HSR Layout', slug: 'hsr-layout', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Indiranagar', slug: 'indiranagar', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Hebbal', slug: 'hebbal', ...IND, state: 'Karnataka', metro: 'bengaluru', locality: true },
  { name: 'Mysuru', slug: 'mysuru', ...IND, state: 'Karnataka', aliases: ['Mysore'] },

  // ---- Chennai ------------------------------------------------------------
  { name: 'Chennai', slug: 'chennai', ...IND, state: 'Tamil Nadu', aliases: ['Madras', 'Chennai City', 'Madras City'], metro: 'chennai' },
  { name: 'Ambattur', slug: 'ambattur', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Guindy', slug: 'guindy', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Porur', slug: 'porur', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Velachery', slug: 'velachery', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Sholinganallur', slug: 'sholinganallur', ...IND, state: 'Tamil Nadu', aliases: ['OMR', 'Old Mahabalipuram Road'], metro: 'chennai', locality: true },
  { name: 'T. Nagar', slug: 't-nagar', ...IND, state: 'Tamil Nadu', aliases: ['Thirandavar Nagar', 'TNagar'], metro: 'chennai', locality: true },
  { name: 'Adyar', slug: 'adyar', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Pallikaranai', slug: 'pallikaranai', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Maraimalai Nagar', slug: 'maraimalai-nagar', ...IND, state: 'Tamil Nadu', aliases: ['Maraimalai'], metro: 'chennai', locality: true },
  { name: 'Sri City', slug: 'sri-city', ...IND, state: 'Tamil Nadu', metro: 'chennai', locality: true },
  { name: 'Coimbatore', slug: 'coimbatore', ...IND, state: 'Tamil Nadu', aliases: [' Kovai'] },
  { name: 'Madurai', slug: 'madurai', ...IND, state: 'Tamil Nadu' },
  { name: 'Tiruchirappalli', slug: 'tiruchirappalli', ...IND, state: 'Tamil Nadu', aliases: ['Trichy', 'Tiruchy', 'Tiruchirappalli'] },
  { name: 'Tiruchengode', slug: 'tiruchengode', ...IND, state: 'Tamil Nadu' },
  { name: 'Kanniyakumari', slug: 'kanniyakumari', ...IND, state: 'Tamil Nadu', aliases: ['Kanyakumari', 'Nagercoil'] },
  { name: 'Salem', slug: 'salem', ...IND, state: 'Tamil Nadu' },
  { name: 'Erode', slug: 'erode', ...IND, state: 'Tamil Nadu' },
  { name: 'Vellore', slug: 'vellore', ...IND, state: 'Tamil Nadu' },
  { name: 'Thoothukudi', slug: 'thoothukudi', ...IND, state: 'Tamil Nadu', aliases: ['Tuticorin'] },

  // ---- Hyderabad ----------------------------------------------------------
  { name: 'Hyderabad', slug: 'hyderabad', ...IND, state: 'Telangana', aliases: ['Hyderabad City', 'Secunderabad'], metro: 'hyderabad' },
  { name: 'Gachibowli', slug: 'gachibowli', ...IND, state: 'Telangana', aliases: ['HITEC City', 'Hitech City'], metro: 'hyderabad', locality: true },
  { name: 'Kukatpally', slug: 'kukatpally', ...IND, state: 'Telangana', metro: 'hyderabad', locality: true },
  { name: 'Uppal', slug: 'uppal', ...IND, state: 'Telangana', metro: 'hyderabad', locality: true },
  { name: 'Begumpet', slug: 'begumpet', ...IND, state: 'Telangana', metro: 'hyderabad', locality: true },
  { name: 'Kachiguda', slug: 'kachiguda', ...IND, state: 'Telangana', metro: 'hyderabad', locality: true },
  { name: 'Warangal', slug: 'warangal', ...IND, state: 'Telangana' },
  { name: 'Vijayawada', slug: 'vijayawada', ...IND, state: 'Andhra Pradesh' },

  // ---- Pune ---------------------------------------------------------------
  { name: 'Pune', slug: 'pune', ...IND, state: 'Maharashtra', aliases: ['Pune City', 'Poona'], metro: 'pune' },
  { name: 'Pimpri-Chinchwad', slug: 'pimpri-chinchwad', ...IND, state: 'Maharashtra', aliases: ['Pimpri', 'Chinchwad', 'PCMC', 'Pimpri Chinchwad'], metro: 'pune', locality: true },
  { name: 'Hinjewadi', slug: 'hinjewadi', ...IND, state: 'Maharashtra', metro: 'pune', locality: true },
  { name: 'Kharadi', slug: 'kharadi', ...IND, state: 'Maharashtra', metro: 'pune', locality: true },
  { name: 'Kothrud', slug: 'kothrud', ...IND, state: 'Maharashtra', metro: 'pune', locality: true },
  { name: 'Hadapsar', slug: 'hadapsar', ...IND, state: 'Maharashtra', metro: 'pune', locality: true },
  { name: 'Viman Nagar', slug: 'viman-nagar', ...IND, state: 'Maharashtra', metro: 'pune', locality: true },
  { name: 'Shivajinagar', slug: 'shivajinagar', ...IND, state: 'Maharashtra', metro: 'pune', locality: true },
  { name: 'Nashik', slug: 'nashik', ...IND, state: 'Maharashtra', aliases: ['Nasik'] },
  { name: 'Nagpur', slug: 'nagpur', ...IND, state: 'Maharashtra', metro: 'nagpur' },

  // ---- Other Indian metros and cities ------------------------------------
  { name: 'Kolkata', slug: 'kolkata', ...IND, state: 'West Bengal', aliases: ['Calcutta', 'Kolkata City'], metro: 'kolkata' },
  { name: 'Salt Lake', slug: 'salt-lake', ...IND, state: 'West Bengal', aliases: ['Bidhannagar', 'Rajarhat'], metro: 'kolkata', locality: true },
  { name: 'Ahmedabad', slug: 'ahmedabad', ...IND, state: 'Gujarat', metro: 'ahmedabad' },
  { name: 'Surat', slug: 'surat', ...IND, state: 'Gujarat' },
  { name: 'Vadodara', slug: 'vadodara', ...IND, state: 'Gujarat', aliases: ['Baroda'] },
  { name: 'Jaipur', slug: 'jaipur', ...IND, state: 'Rajasthan', metro: 'jaipur' },
  { name: 'Jodhpur', slug: 'jodhpur', ...IND, state: 'Rajasthan' },
  { name: 'Lucknow', slug: 'lucknow', ...IND, state: 'Uttar Pradesh', metro: 'lucknow' },
  { name: 'Kanpur', slug: 'kanpur', ...IND, state: 'Uttar Pradesh' },
  { name: 'Agra', slug: 'agra', ...IND, state: 'Uttar Pradesh' },
  { name: 'Varanasi', slug: 'varanasi', ...IND, state: 'Uttar Pradesh', aliases: ['Banaras'] },
  { name: 'Meerut', slug: 'meerut', ...IND, state: 'Uttar Pradesh' },
  { name: 'Mathura', slug: 'mathura', ...IND, state: 'Uttar Pradesh' },
  { name: 'Aligarh', slug: 'aligarh', ...IND, state: 'Uttar Pradesh' },
  { name: 'Patna', slug: 'patna', ...IND, state: 'Bihar' },
  { name: 'Bhopal', slug: 'bhopal', ...IND, state: 'Madhya Pradesh' },
  { name: 'Indore', slug: 'indore', ...IND, state: 'Madhya Pradesh' },
  { name: 'Jabalpur', slug: 'jabalpur', ...IND, state: 'Madhya Pradesh' },
  { name: 'Gwalior', slug: 'gwalior', ...IND, state: 'Madhya Pradesh' },
  { name: 'Ujjain', slug: 'ujjain', ...IND, state: 'Madhya Pradesh' },
  { name: 'Jaunpur', slug: 'jaunpur', ...IND, state: 'Uttar Pradesh' },
  { name: 'Ranchi', slug: 'ranchi', ...IND, state: 'Jharkhand' },
  { name: 'Dhanbad', slug: 'dhanbad', ...IND, state: 'Jharkhand' },
  { name: 'Jamshedpur', slug: 'jamshedpur', ...IND, state: 'Jharkhand' },
  { name: 'Bokaro', slug: 'bokaro', ...IND, state: 'Jharkhand' },
  { name: 'Guwahati', slug: 'guwahati', ...IND, state: 'Assam', aliases: ['Gauhati'] },
  { name: 'Dibrugarh', slug: 'dibrugarh', ...IND, state: 'Assam' },
  { name: 'Silchar', slug: 'silchar', ...IND, state: 'Assam' },
  { name: 'Imphal', slug: 'imphal', ...IND, state: 'Manipur' },
  { name: 'Shillong', slug: 'shillong', ...IND, state: 'Meghalaya' },
  { name: 'Bhubaneswar', slug: 'bhubaneswar', ...IND, state: 'Odisha', aliases: ['Bhubaneshwar'] },
  { name: 'Rourkela', slug: 'rourkela', ...IND, state: 'Odisha' },
  { name: 'Cuttack', slug: 'cuttack', ...IND, state: 'Odisha' },
  { name: 'Chandigarh', slug: 'chandigarh', ...IND, state: 'Chandigarh' },
  { name: 'Mohali', slug: 'mohali', ...IND, state: 'Punjab' },
  { name: 'Ludhiana', slug: 'ludhiana', ...IND, state: 'Punjab' },
  { name: 'Amritsar', slug: 'amritsar', ...IND, state: 'Punjab' },
  { name: 'Jalandhar', slug: 'jalandhar', ...IND, state: 'Punjab', aliases: ['Jalandhar'] },
  { name: 'Dehradun', slug: 'dehradun', ...IND, state: 'Uttarakhand' },
  { name: 'Haridwar', slug: 'haridwar', ...IND, state: 'Uttarakhand' },
  { name: 'Srinagar', slug: 'srinagar', ...IND, state: 'Jammu and Kashmir' },
  { name: 'Jammu', slug: 'jammu', ...IND, state: 'Jammu and Kashmir' },
  { name: 'Raipur', slug: 'raipur', ...IND, state: 'Chhattisgarh' },
  { name: 'Bhilai', slug: 'bhilai', ...IND, state: 'Chhattisgarh' },
  { name: 'Shimla', slug: 'shimla', ...IND, state: 'Himachal Pradesh' },
  { name: 'Manali', slug: 'manali', ...IND, state: 'Himachal Pradesh' },
  { name: 'Chodavaram', slug: 'chodavaram', ...IND, state: 'Andhra Pradesh' },
  { name: 'Nuzvid', slug: 'nuzvid', ...IND, state: 'Andhra Pradesh' },
  { name: 'Guntur', slug: 'guntur', ...IND, state: 'Andhra Pradesh' },
  { name: 'Tekkali', slug: 'tekkali', ...IND, state: 'Odisha' },
  { name: 'Srikakulam', slug: 'srikakulam', ...IND, state: 'Andhra Pradesh' },
  { name: 'Kottayam', slug: 'kottayam', ...IND, state: 'Kerala' },
  { name: 'Kochi', slug: 'kochi', ...IND, state: 'Kerala', aliases: ['Cochin', 'Ernakulam'], metro: 'kochi' },
  { name: 'Thiruvananthapuram', slug: 'thiruvananthapuram', ...IND, state: 'Kerala', aliases: ['Trivandrum'] },
  { name: 'Kozhikode', slug: 'kozhikode', ...IND, state: 'Kerala', aliases: ['Calicut'] },
  { name: 'Mangaluru', slug: 'mangaluru', ...IND, state: 'Karnataka', aliases: ['Mangalore'] },
  { name: 'Hubballi', slug: 'hubballi', ...IND, state: 'Karnataka', aliases: ['Hubli'] },
  { name: 'Belagavi', slug: 'belagavi', ...IND, state: 'Karnataka', aliases: ['Belgaum'] },
  { name: 'Kotamangalam', slug: 'kotamangalam', ...IND, state: 'Kerala' },
  { name: 'Kurukshetra', slug: 'kurukshetra', ...IND, state: 'Haryana' },
  { name: 'Karniyakumari', slug: 'karniyakumari', ...IND, state: 'Tamil Nadu' },
  { name: 'Faridabad', slug: 'faridabad-dup', ...IND, state: 'Haryana', metro: 'delhi-ncr', locality: true },
  { name: 'Jind', slug: 'jind', ...IND, state: 'Haryana' },
  { name: 'Sonipat', slug: 'sonipat', ...IND, state: 'Haryana' },
  { name: 'Panipat', slug: 'panipat', ...IND, state: 'Haryana' },
  { name: 'Fatehgarh', slug: 'fatehgarh', ...IND, state: 'Haryana' },
  { name: 'Ajitgarh', slug: 'ajitgarh', ...IND, state: 'Punjab', aliases: ['Noh'] },
  { name: 'Dera Bassi', slug: 'dera-bassi', ...IND, state: 'Punjab' },
  { name: 'Mohali', slug: 'mohali-dup', ...IND, state: 'Punjab' },
  { name: 'Sangrur', slug: 'sangrur', ...IND, state: 'Punjab' },
  { name: 'Laungowal', slug: 'laungowal', ...IND, state: 'Punjab' },
  { name: 'Morinda', slug: 'morinda', ...IND, state: 'Punjab' },

  // ---- International cities ----------------------------------------------
  { name: 'New York', slug: 'new-york', country: 'United States', countryCode: 'US', state: 'New York', aliases: ['NYC', 'New York City', 'Manhattan', 'Brooklyn'], metro: 'new-york' },
  { name: 'San Francisco', slug: 'san-francisco', country: 'United States', countryCode: 'US', state: 'California', aliases: ['SF', 'San Fran'], metro: 'bay-area' },
  { name: 'Berkeley', slug: 'berkeley', country: 'United States', countryCode: 'US', state: 'California', metro: 'bay-area', locality: true },
  { name: 'Palo Alto', slug: 'palo-alto', country: 'United States', countryCode: 'US', state: 'California', metro: 'bay-area', locality: true },
  { name: 'San Jose', slug: 'san-jose', country: 'United States', countryCode: 'US', state: 'California', metro: 'bay-area', locality: true },
  { name: 'Los Angeles', slug: 'los-angeles', country: 'United States', countryCode: 'US', state: 'California', aliases: ['LA'], metro: 'los-angeles' },
  { name: 'Austin', slug: 'austin', country: 'United States', countryCode: 'US', state: 'Texas' },
  { name: 'Boston', slug: 'boston', country: 'United States', countryCode: 'US', state: 'Massachusetts', aliases: ['Cambridge', 'MIT'] },
  { name: 'Chicago', slug: 'chicago', country: 'United States', countryCode: 'US', state: 'Illinois' },
  { name: 'Seattle', slug: 'seattle', country: 'United States', countryCode: 'US', state: 'Washington' },
  { name: 'Atlanta', slug: 'atlanta', country: 'United States', countryCode: 'US', state: 'Georgia' },
  { name: 'Washington', slug: 'washington-dc', country: 'United States', countryCode: 'US', state: 'District of Columbia', aliases: ['Washington DC', 'Washington, D.C.'] },
  { name: 'Toronto', slug: 'toronto', country: 'Canada', countryCode: 'CA', state: 'Ontario', metro: 'toronto' },
  { name: 'Waterloo', slug: 'waterloo', country: 'Canada', countryCode: 'CA', state: 'Ontario', metro: 'toronto', locality: true },
  { name: 'Montreal', slug: 'montreal', country: 'Canada', countryCode: 'CA', state: 'Quebec', aliases: ['Montréal'] },
  { name: 'Vancouver', slug: 'vancouver', country: 'Canada', countryCode: 'CA', state: 'British Columbia' },
  { name: 'London', slug: 'london', country: 'United Kingdom', countryCode: 'GB', aliases: ['London UK'], metro: 'london' },
  { name: 'Manchester', slug: 'manchester', country: 'United Kingdom', countryCode: 'GB' },
  { name: 'Edinburgh', slug: 'edinburgh', country: 'United Kingdom', countryCode: 'GB' },
  { name: 'Dublin', slug: 'dublin', country: 'Ireland', countryCode: 'IE' },
  { name: 'Berlin', slug: 'berlin', country: 'Germany', countryCode: 'DE', metro: 'berlin' },
  { name: 'Munich', slug: 'munich', country: 'Germany', countryCode: 'DE', aliases: ['München'] },
  { name: 'Amsterdam', slug: 'amsterdam', country: 'Netherlands', countryCode: 'NL', metro: 'amsterdam' },
  { name: 'Rotterdam', slug: 'rotterdam', country: 'Netherlands', countryCode: 'NL', metro: 'amsterdam', locality: true },
  { name: 'Madrid', slug: 'madrid', country: 'Spain', countryCode: 'ES' },
  { name: 'Barcelona', slug: 'barcelona', country: 'Spain', countryCode: 'ES' },
  { name: 'Lisbon', slug: 'lisbon', country: 'Portugal', countryCode: 'PT' },
  { name: 'Paris', slug: 'paris', country: 'France', countryCode: 'FR' },
  { name: 'Stockholm', slug: 'stockholm', country: 'Sweden', countryCode: 'SE' },
  { name: 'Zurich', slug: 'zurich', country: 'Switzerland', countryCode: 'CH', aliases: ['Zürich'] },
  { name: 'Singapore', slug: 'singapore', country: 'Singapore', countryCode: 'SG' },
  { name: 'Tokyo', slug: 'tokyo', country: 'Japan', countryCode: 'JP' },
  { name: 'Seoul', slug: 'seoul', country: 'South Korea', countryCode: 'KR' },
  { name: 'Bengaluru', slug: 'bengaluru-dup', ...IND, state: 'Karnataka', metro: 'bengaluru' },
  { name: 'Sydney', slug: 'sydney', country: 'Australia', countryCode: 'AU', state: 'New South Wales' },
  { name: 'Melbourne', slug: 'melbourne', country: 'Australia', countryCode: 'AU', state: 'Victoria' },
  { name: 'Cape Town', slug: 'cape-town', country: 'South Africa', countryCode: 'ZA' },
  { name: 'Johannesburg', slug: 'johannesburg', country: 'South Africa', countryCode: 'ZA' },
  { name: 'Nairobi', slug: 'nairobi', country: 'Kenya', countryCode: 'KE' },
  { name: 'Lagos', slug: 'lagos', country: 'Nigeria', countryCode: 'NG' },
  { name: 'Abu Dhabi', slug: 'abu-dhabi', country: 'United Arab Emirates', countryCode: 'AE' },
  { name: 'Doha', slug: 'doha', country: 'Qatar', countryCode: 'QA' },
];

/** States/regions we strip from a free-text query such as "Chennai, Tamil Nadu". */
export const STATE_NAMES: string[] = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala',
  'Ladakh', 'Ladakh UT', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Orissa', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands',
  'Alabama', 'Arizona', 'California', 'Colorado', 'Florida', 'Georgia', 'Illinois',
  'Maryland', 'Massachusetts', 'Michigan', 'New Jersey', 'New York', 'North Carolina',
  'Ohio', 'Oregon', 'Pennsylvania', 'Texas', 'Virginia', 'Washington', 'Wisconsin',
  'Ontario', 'Quebec', 'British Columbia', 'Alberta', 'Nova Scotia',
  'England', 'Scotland', 'Wales', 'Northern Ireland', 'London', 'Greater London',
  'Bayern', 'Berlin', 'Hessen', 'Nordrhein-Westfalen',
  'New South Wales', 'Victoria', 'Queensland', 'Western Australia',
];

export const COUNTRY_NAMES: string[] = [
  'India', 'United States', 'United States of America', 'USA', 'Canada', 'United Kingdom',
  'UK', 'Great Britain', 'Ireland', 'Germany', 'Netherlands', 'Spain', 'Portugal',
  'France', 'Sweden', 'Switzerland', 'Singapore', 'Japan', 'South Korea', 'Korea',
  'Australia', 'New Zealand', 'South Africa', 'Kenya', 'Nigeria', 'Egypt', 'Brazil',
  'Mexico', 'Indonesia', 'Malaysia', 'Thailand', 'Vietnam', 'Philippines', 'Turkey',
  'Poland', 'Czechia', 'Austria', 'Belgium', 'Denmark', 'Norway', 'Finland', 'Greece',
  'Israel', 'United Arab Emirates', 'Qatar', 'Saudi Arabia', 'Estonia', 'Lithuania',
  'Latvia', 'Romania', 'Hungary', 'Croatia', 'Serbia', 'Ukraine', 'Russia',
];

const DIACRITIC = /[\u0300-\u036f]/g;

export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(DIACRITIC, '');
}

/** Lowercase, de-accent, strip punctuation, collapse whitespace. */
export function normalizeKey(input: string): string {
  return stripDiacritics(String(input ?? ''))
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Reduce "Chennai, Tamil Nadu, India" to "chennai".
 * Only trailing state/country tokens are removed, so a city literally named
 * "Delhi" is not destroyed.
 */
export function stripRegionSuffixes(input: string): string {
  let key = normalizeKey(input);
  if (!key) return '';
  const stateSet = new Set(STATE_NAMES.map(normalizeKey));
  const countrySet = new Set(COUNTRY_NAMES.map(normalizeKey));
  const inSet = new Set(['in', 'india', 'us', 'usa', 'uk']);
  let changed = true;
  let guard = 0;
  while (changed && guard < 6) {
    changed = false;
    guard += 1;
    const parts = key.split(' ').filter(Boolean);
    if (parts.length <= 1) break;
    const tail = parts.slice(1).join(' ');
    if (stateSet.has(tail) || countrySet.has(tail) || inSet.has(tail)) {
      key = parts[0];
      changed = true;
      continue;
    }
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && (countrySet.has(last) || inSet.has(last) || /^[a-z]{2}$/.test(last) && countrySet.has(parts.slice(-2).join(' ')))) {
      parts.pop();
      key = parts.join(' ');
      changed = true;
    }
  }
  return key;
}

interface RegistryIndex {
  bySlug: Map<string, CityDefinition>;
  byName: Map<string, CityDefinition>;
  byAlias: Map<string, CityDefinition[]>;
  byMetro: Map<string, CityDefinition[]>;
  all: CityDefinition[];
}

function buildIndex(): RegistryIndex {
  const bySlug = new Map<string, CityDefinition>();
  const byName = new Map<string, CityDefinition>();
  const byAlias = new Map<string, CityDefinition[]>();
  const byMetro = new Map<string, CityDefinition[]>();
  const all: CityDefinition[] = [];

  for (const def of CITY_DEFINITIONS) {
    // Skip duplicate-slug placeholders added only to keep keys unique; the
    // canonical definition is the first one registered under a base slug.
    const baseSlug = def.slug.replace(/-dup$/, '');
    if (bySlug.has(baseSlug)) continue;
    const entry: CityDefinition = { ...def, slug: baseSlug };
    bySlug.set(baseSlug, entry);
    all.push(entry);
    byName.set(normalizeKey(entry.name), entry);
    for (const alias of entry.aliases ?? []) {
      const k = normalizeKey(alias);
      if (!k) continue;
      const list = byAlias.get(k) ?? [];
      if (!list.includes(entry)) list.push(entry);
      byAlias.set(k, list);
    }
    // A city is reachable by its own name as an alias too.
    const selfKey = normalizeKey(entry.name);
    const selfList = byAlias.get(selfKey) ?? [];
    if (!selfList.includes(entry)) selfList.push(entry);
    byAlias.set(selfKey, selfList);
    if (entry.metro) {
      const list = byMetro.get(entry.metro) ?? [];
      list.push(entry);
      byMetro.set(entry.metro, list);
    }
  }
  return { bySlug, byName, byAlias, byMetro, all };
}

export const CITY_INDEX: RegistryIndex = buildIndex();

export function metroMembersFor(metro: string | null | undefined): CityDefinition[] {
  if (!metro) return [];
  return CITY_INDEX.byMetro.get(metro) ?? [];
}

export function metroLabel(metro: string | null | undefined): string | null {
  if (!metro) return null;
  return METRO_DEFS.find((m) => m.key === metro)?.label ?? null;
}

export type CityMatchKind = 'exact' | 'alias' | 'metro' | 'state' | 'unknown';

export interface CityMatch {
  match: CityMatchKind;
  definitions: CityDefinition[];
  notes: string[];
  /** The canonical city that the query was understood to mean. */
  primary: CityDefinition | null;
  /** Keys that a database lookup should treat as this city (canonical + metro siblings). */
  equivalentKeys: string[];
}

/**
 * Resolve a user's typed location against the registry.
 *
 * `nearby` includes the canonical city, its aliases and its metro siblings so
 * that a search for "Chennai" can surface an event in "Ambattur" or "OMR", while
 * "Bombay" resolves to Mumbai and "Bangalore Urban" to Bengaluru.
 */
export function matchCity(query: string, opts: { includeMetro?: boolean } = {}): CityMatch {
  const includeMetro = opts.includeMetro ?? true;
  const raw = normalizeKey(query);
  const notes: string[] = [];
  if (!raw) return { match: 'unknown', definitions: [], notes, primary: null, equivalentKeys: [] };

  const bare = stripRegionSuffixes(query) || raw;

  // 1. Exact canonical name.
  const exact = CITY_INDEX.byName.get(bare) ?? CITY_INDEX.byName.get(raw);
  if (exact) {
    notes.push(`Matched city "${exact.name}".`);
    return finish(exact, 'exact', notes, includeMetro);
  }

  // 2. Alias / alternate spelling (Bangalore -> Bengaluru, Bombay -> Mumbai).
  const aliases = CITY_INDEX.byAlias.get(bare) ?? CITY_INDEX.byAlias.get(raw);
  if (aliases && aliases.length > 0) {
    const def = aliases[0];
    notes.push(`"${query.trim()}" is a known alternate name for ${def.name}.`);
    return finish(def, 'alias', notes, includeMetro);
  }

  // 3. Exact slug match.
  const slug = bare.replace(/[^a-z0-9]+/g, '-');
  const bySlug = CITY_INDEX.bySlug.get(slug);
  if (bySlug) {
    notes.push(`Matched city "${bySlug.name}".`);
    return finish(bySlug, 'exact', notes, includeMetro);
  }

  // 4. Try a multi-word metro sibling name, e.g. "Pimpri Chinchwad" already
  //    handled by aliases; here handle "<known city> <qualifier>" such as
  //    "Mumbai West" or "Bangalore Urban District".
  const metroHit = findMetroByCompoundName(bare);
  if (metroHit) {
    notes.push(`Understood "${query.trim()}" as ${metroHit.name}.`);
    return finish(metroHit, 'alias', notes, includeMetro);
  }

  return { match: 'unknown', definitions: [], notes, primary: null, equivalentKeys: [] };
}

function findMetroByCompoundName(key: string): CityDefinition | null {
  for (const def of CITY_INDEX.all) {
    const name = normalizeKey(def.name);
    if (!name) continue;
    if (key === name) return def;
    if (key.endsWith(` ${name}`) || key.startsWith(`${name} `)) {
      // "bangalore urban district" -> Bengaluru; "south west mumbai" -> Mumbai
      const rest = key.replace(name, ' ').replace(/\s+/g, ' ').trim();
      if (rest.split(' ').every((t) => QUALIFIER_TOKENS.has(t))) return def;
    }
  }
  return null;
}

const QUALIFIER_TOKENS = new Set([
  'urban', 'city', 'district', 'north', 'south', 'east', 'west', 'central',
  'greater', 'new', 'metro', 'metropolitan', 'region', 'area', 'sub',
]);

function finish(def: CityDefinition, match: CityMatchKind, notes: string[], includeMetro: boolean): CityMatch {
  const equivalents = new Set<string>();
  equivalents.add(def.slug);
  for (const a of def.aliases ?? []) equivalents.add(normalizeKey(a).replace(/[^a-z0-9]+/g, '-'));
  if (includeMetro) {
    for (const sibling of metroMembersFor(def.metro)) {
      equivalents.add(sibling.slug);
      for (const a of sibling.aliases ?? []) equivalents.add(normalizeKey(a).replace(/[^a-z0-9]+/g, '-'));
    }
  }
  return {
    match,
    definitions: [def, ...(includeMetro ? metroMembersFor(def.metro).filter((d) => d.slug !== def.slug) : [])],
    notes,
    primary: def,
    equivalentKeys: [...equivalents],
  };
}

/**
 * City keys worth including for a text search. Exact city only, no metro
 * expansion — used when the user explicitly picks "exact city".
 */
export function exactCityKeys(query: string): string[] {
  const m = matchCity(query, { includeMetro: false });
  if (!m.primary) {
    const bare = stripRegionSuffixes(query);
    return bare ? [bare] : [];
  }
  const keys = [m.primary.slug];
  for (const a of m.primary.aliases ?? []) keys.push(normalizeKey(a).replace(/[^a-z0-9]+/g, '-'));
  return [...new Set(keys)];
}

/** Suggest cities for the search box autocomplete. */
export function suggestCities(input: string, limit = 8): CityDefinition[] {
  const key = stripRegionSuffixes(input);
  if (!key) {
    return CITY_INDEX.all.filter((d) => !d.locality).slice(0, limit);
  }
  const scored: Array<{ def: CityDefinition; score: number }> = [];
  for (const def of CITY_INDEX.all) {
    const name = normalizeKey(def.name);
    const aliases = (def.aliases ?? []).map(normalizeKey);
    let score = -1;
    if (name === key) score = 100;
    else if (name.startsWith(key)) score = 80 - name.length / 10;
    else if (aliases.includes(key)) score = 75;
    else if (name.includes(key)) score = 60 - name.length / 20;
    else if (aliases.some((a) => a.includes(key))) score = 50;
    if (score > 0) scored.push({ def, score: score - (def.locality ? 8 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.def);
}

/** Cities with the most hackathons, used for the "popular cities" chips. */
export function popularCities(limit = 8): string[] {
  return ['Chennai', 'Bengaluru', 'Hyderabad', 'Mumbai', 'Delhi', 'Pune', 'Kolkata', 'Coimbatore'].slice(0, limit);
}
