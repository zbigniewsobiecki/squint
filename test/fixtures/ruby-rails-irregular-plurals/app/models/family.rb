class Family < ApplicationRecord
  has_many :people
  has_many :children
end
