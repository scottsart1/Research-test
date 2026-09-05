export const PROPERTY_CATALOG = [
  { id: "mediterranean", name: "Mediterranean Avenue", type: "street", group: "Brown", price: 60, mortgage: 30, buildCost: 50, rents: [2,10,30,90,160,250] },
  { id: "baltic", name: "Baltic Avenue", type: "street", group: "Brown", price: 60, mortgage: 30, buildCost: 50, rents: [4,20,60,180,320,450] },
  { id: "reading-railroad", name: "Reading Railroad", type: "railroad", group: "Railroad", price: 200, mortgage: 100 },
  { id: "oriental", name: "Oriental Avenue", type: "street", group: "Light Blue", price: 100, mortgage: 50, buildCost: 50, rents: [6,30,90,270,400,550] },
  { id: "vermont", name: "Vermont Avenue", type: "street", group: "Light Blue", price: 100, mortgage: 50, buildCost: 50, rents: [6,30,90,270,400,550] },
  { id: "connecticut", name: "Connecticut Avenue", type: "street", group: "Light Blue", price: 120, mortgage: 60, buildCost: 50, rents: [8,40,100,300,450,600] },
  { id: "st-charles", name: "St. Charles Place", type: "street", group: "Pink", price: 140, mortgage: 70, buildCost: 100, rents: [10,50,150,450,625,750] },
  { id: "electric-company", name: "Electric Company", type: "utility", group: "Utility", price: 150, mortgage: 75 },
  { id: "states", name: "States Avenue", type: "street", group: "Pink", price: 140, mortgage: 70, buildCost: 100, rents: [10,50,150,450,625,750] },
  { id: "virginia", name: "Virginia Avenue", type: "street", group: "Pink", price: 160, mortgage: 80, buildCost: 100, rents: [12,60,180,500,700,900] },
  { id: "pennsylvania-railroad", name: "Pennsylvania Railroad", type: "railroad", group: "Railroad", price: 200, mortgage: 100 },
  { id: "st-james", name: "St. James Place", type: "street", group: "Orange", price: 180, mortgage: 90, buildCost: 100, rents: [14,70,200,550,750,950] },
  { id: "tennessee", name: "Tennessee Avenue", type: "street", group: "Orange", price: 180, mortgage: 90, buildCost: 100, rents: [14,70,200,550,750,950] },
  { id: "new-york", name: "New York Avenue", type: "street", group: "Orange", price: 200, mortgage: 100, buildCost: 100, rents: [16,80,220,600,800,1000] },
  { id: "bo-railroad", name: "B. & O. Railroad", type: "railroad", group: "Railroad", price: 200, mortgage: 100 },
  { id: "kentucky", name: "Kentucky Avenue", type: "street", group: "Red", price: 220, mortgage: 110, buildCost: 150, rents: [18,90,250,700,875,1050] },
  { id: "indiana", name: "Indiana Avenue", type: "street", group: "Red", price: 220, mortgage: 110, buildCost: 150, rents: [18,90,250,700,875,1050] },
  { id: "illinois", name: "Illinois Avenue", type: "street", group: "Red", price: 240, mortgage: 120, buildCost: 150, rents: [20,100,300,750,925,1100] },
  { id: "atlantic", name: "Atlantic Avenue", type: "street", group: "Yellow", price: 260, mortgage: 130, buildCost: 150, rents: [22,110,330,800,975,1150] },
  { id: "ventnor", name: "Ventnor Avenue", type: "street", group: "Yellow", price: 260, mortgage: 130, buildCost: 150, rents: [22,110,330,800,975,1150] },
  { id: "water-works", name: "Water Works", type: "utility", group: "Utility", price: 150, mortgage: 75 },
  { id: "marvin-gardens", name: "Marvin Gardens", type: "street", group: "Yellow", price: 280, mortgage: 140, buildCost: 150, rents: [24,120,360,850,1025,1200] },
  { id: "short-line", name: "Short Line", type: "railroad", group: "Railroad", price: 200, mortgage: 100 },
  { id: "pacific", name: "Pacific Avenue", type: "street", group: "Green", price: 300, mortgage: 150, buildCost: 200, rents: [26,130,390,900,1100,1275] },
  { id: "north-carolina", name: "North Carolina Avenue", type: "street", group: "Green", price: 300, mortgage: 150, buildCost: 200, rents: [26,130,390,900,1100,1275] },
  { id: "pennsylvania-avenue", name: "Pennsylvania Avenue", type: "street", group: "Green", price: 320, mortgage: 160, buildCost: 200, rents: [28,150,450,1000,1200,1400] },
  { id: "park-place", name: "Park Place", type: "street", group: "Dark Blue", price: 350, mortgage: 175, buildCost: 200, rents: [35,175,500,1100,1300,1500] },
  { id: "boardwalk", name: "Boardwalk", type: "street", group: "Dark Blue", price: 400, mortgage: 200, buildCost: 200, rents: [50,200,600,1400,1700,2000] }
];

export const GROUP_SIZES = PROPERTY_CATALOG.reduce((acc, property) => {
  if (property.type === "street") acc[property.group] = (acc[property.group] || 0) + 1;
  return acc;
}, {});
